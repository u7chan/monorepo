/**
 * 設定 → Git の GUI 受入。有料 API を使わない GUI fixture（stub pi + 一時サンドボックス +
 * 一時アプリ DB）に対して、保存 / 検証 / 再読み込み / クリア / 確認ダイアログ / same-origin の
 * 防護 / 実行環境の診断 / 予約名の注記を確かめる。
 *
 * 実行:
 *   pw.sh open http://127.0.0.1:17982/
 *   pw.sh run-code --filename=projects/u7agent/scripts/check-git-settings.js
 *   pw.sh close
 *
 * アプリ DB は一時ストアなので、何度でも最初の「未設定」から再現できる。
 * 予約名の既存行（アップグレード前の DB）は API が予約名を拒否するため、fixture の store に直接 1 行入れておく:
 *   SID=$(curl -s http://127.0.0.1:17980/api/sessions | jq -r '.sessions[0].sessionId')
 *   node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.prepare(
 *     "INSERT OR REPLACE INTO secrets (secretId,cwd,name,kind,plaintext,sortOrder,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)"
 *   ).run("e2e-git-config-count",".u7agent/sessions/"+process.argv[2],"GIT_CONFIG_COUNT","variable","1",1,Date.now(),Date.now())' \
 *     "$ROOT/store/u7agent.db" "$SID"
 */
async function checkGitSettings(page) {
  const problems = [];
  const check = (ok, message) => {
    if (!ok) problems.push(message);
  };
  const textIncludes = async (text) => (await page.locator("body").innerText()).includes(text);
  const waitText = async (text, timeout = 10_000) => {
    await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
  };

  const base = new URL(page.url()).origin;
  const api = async (path, init) => {
    const response = await page.request.fetch(`${base}${path}`, init);
    const body = await response.json().catch(() => null);
    return { status: response.status(), body };
  };

  // 1. 未設定のバッジとフォーム
  await page.goto(`${base}/settings/git`);
  await page.getByRole("heading", { name: "Git", exact: true }).waitFor({ timeout: 10_000 });
  await waitText("Git identity 未設定");
  const nameInput = page.getByLabel(/名前（user\.name）/);
  const emailInput = page.getByLabel(/メールアドレス（user\.email）/);
  const saveButton = page.getByRole("button", { name: "保存", exact: true });
  await nameInput.waitFor();
  await emailInput.waitFor();

  const clearButton = page.getByRole("button", { name: "未設定に戻す" });
  check(await clearButton.isDisabled(), "未設定なのに「未設定に戻す」が押せる");

  const initial = await api("/api/settings/git");
  check(initial.status === 200, `GET /api/settings/git の status が ${initial.status}`);
  check(initial.body?.configured === false, "初期状態が未設定ではない");
  check(initial.body?.userName === null && initial.body?.userEmail === null, "初期値が null ではない");
  check(await saveButton.isDisabled(), "空欄のまま保存できる");

  // 2. 片方だけ / 形状違反は保存できない（クライアント側で止める）
  await nameInput.fill("u7chan");
  check(await saveButton.isDisabled(), "メールアドレスが空でも保存できる");
  check(await textIncludes("Git のメールアドレスを入力してください"), "片方だけの理由が出ない");

  await emailInput.fill("not-an-email");
  check(await saveButton.isDisabled(), "形状違反のメールアドレスでも保存できる");
  check(await textIncludes("Git のメールアドレスの形式が正しくありません"), "形状違反の理由が出ない");

  // 内部の改行・値は server でも拒否される。ここでは < > を確かめる
  await emailInput.fill("u7chan@example.com");
  await nameInput.fill("u7<chan");
  check(await saveButton.isDisabled(), "< を含む名前でも保存できる");
  check(await textIncludes("Git の名前とメールアドレスに < と > は使えません"), "< > の理由が出ない");

  // 3. 保存
  await nameInput.fill("u7chan");
  await saveButton.click();
  await waitText("保存しました");
  await waitText("設定済み");
  const saved = await api("/api/settings/git");
  check(
    saved.body?.userName === "u7chan" &&
      saved.body?.userEmail === "u7chan@example.com" &&
      saved.body?.configured === true,
    `保存後の GET が一致しない: ${JSON.stringify(saved.body)}`,
  );

  // 4. 再読み込みしても保存値とバッジが残る
  await page.reload();
  await page.getByRole("heading", { name: "Git", exact: true }).waitFor({ timeout: 10_000 });
  check((await nameInput.inputValue()) === "u7chan", "再読み込みで名前が戻らない");
  check((await emailInput.inputValue()) === "u7chan@example.com", "再読み込みでメールが戻らない");
  check(await textIncludes("設定済み"), "再読み込みでバッジが設定済みにならない");

  // 5. same-origin の防護（ヘッダ無しの直接クライアントは 403）
  const direct = await page.request.put(`${base}/api/settings/git`, {
    data: { userName: "hacked", userEmail: "hacked@example.com" },
  });
  check(direct.status() === 403, `ヘッダ無しの PUT が 403 でない: ${direct.status()}`);
  const crossOrigin = await page.request.put(`${base}/api/settings/git`, {
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    data: { userName: "hacked", userEmail: "hacked@example.com" },
  });
  check(crossOrigin.status() === 403, `別 origin の PUT が 403 でない: ${crossOrigin.status()}`);
  const unchanged = await api("/api/settings/git");
  check(unchanged.body?.userName === "u7chan", "拒否された PUT が保存値を変えた");

  // 6. 確認ダイアログのキャンセルでは消えない
  await clearButton.click();
  const dialog = page.getByRole("dialog", { name: "Git identity を未設定に戻す" });
  await dialog.waitFor();
  const cancelFocused = await page.evaluate(() => document.activeElement?.textContent?.trim() === "キャンセル");
  check(cancelFocused, "確認ダイアログの初期焦点がキャンセルでない");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await dialog.waitFor({ state: "hidden" });
  check((await nameInput.inputValue()) === "u7chan", "キャンセルで名前が消えた");
  check((await api("/api/settings/git")).body?.configured === true, "キャンセルで保存値が消えた");

  // 7. クリア（冪等）
  await clearButton.click();
  await dialog.getByRole("button", { name: "未設定に戻す" }).click();
  await waitText("未設定に戻しました");
  await waitText("Git identity 未設定");
  const cleared = await api("/api/settings/git");
  check(cleared.body?.configured === false, "クリア後の GET が未設定でない");
  check(await clearButton.isDisabled(), "クリア後も「未設定に戻す」が押せる");
  const clearedAgain = await page.request.delete(`${base}/api/settings/git`, {
    headers: { Origin: base, "Sec-Fetch-Site": "same-origin" },
  });
  check(clearedAgain.status() === 200, `2 回目の DELETE が 200 でない: ${clearedAgain.status()}`);

  // 8. 実行環境の診断に Git の設定が出る（実サンドボックス）
  await page.goto(`${base}/settings/runtime/environment`);
  await waitText("Git の設定", 15_000);
  check(await textIncludes("準備済み"), "実行環境の Git の設定が準備済みでない");
  check(await textIncludes("/.config/u7agent/gitconfig"), "実行環境に解決パスが出ない");

  // 9. 予約名の既存行は一覧に「予約名のため無視」と出る
  const sessions = await api("/api/sessions");
  const sessionId = sessions.body?.sessions?.[0]?.sessionId;
  check(Boolean(sessionId), "会話が取得できない");
  if (sessionId) {
    // 新規登録は BFF が予約名を拒否する。ここでは DB に直接入れた既存行（アップグレード前）を読む
    const list = await api(`/api/secrets?sessionId=${encodeURIComponent(sessionId)}`);
    const item = list.body?.items?.find((entry) => entry.name === "GIT_CONFIG_COUNT");
    check(item?.ignoredByGit === true, "予約名の既存行に ignoredByGit が付かない（fixture の DB に seed したか）");

    await page.goto(`${base}/s/${sessionId}`);
    await page.getByRole("button", { name: "作業環境" }).first().click();
    await page.getByRole("tab", { name: "環境変数" }).click();
    await waitText("予約名のため無視");
  }

  await page.screenshot({ path: "/tmp/u7agent-git-settings-desktop.png", fullPage: true });

  if (problems.length > 0) throw new Error(`Git 設定の受入に失敗:\n- ${problems.join("\n- ")}`);
  return {
    desktop: "ok",
    saved: saved.body,
    cleared: cleared.body,
    runtime: "Git の設定: 準備済み",
    reservedEnvRow: "予約名のため無視",
  };
}
