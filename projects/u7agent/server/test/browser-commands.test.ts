// shot / dom / check を実ブラウザ (playwright-core の同梱ブラウザ) で検証する。
// 分類は実ブラウザの挙動 (proxy の 403・requestfailed の出方・遅延した例外) に依存するため、
// ループバック fixture を入力にして分類ごとの項目と保存の契約をここで固定する。
// ブラウザが無い環境では skip する (イメージの probe が同梱物を別途検査する)。

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { checkExitCode, formatCheckReport, runCheck, type CheckCategory, type CheckReport } from "../src/browser/check";
import { runDom } from "../src/browser/dom";
import { EXIT_VALIDATION_FAILED } from "../src/browser/exit-codes";
import {
  CHECK_FIXTURE_PATHS,
  checkFixtureResponses,
  reserveClosedPort,
  startLoopbackFixture,
} from "../src/browser/fixture";
import { ReachDeniedError } from "../src/browser/navigation";
import { openBrowserSession, type BrowserSession } from "../src/browser/session";
import { runShot } from "../src/browser/shot";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LINK_LOCAL = "http://169.254.169.254/";

/** IHDR の幅と高さ。画像ライブラリを足さずに viewport と fullPage の反映を確かめる */
function pngSize(image: Buffer): { width: number; height: number } {
  assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE), "PNG の署名ではありません");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

const APP_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture app</title></head>
<body><div id="app-probe">app-ok</div><p>日本語のラベルと絵文字 🎉🚀</p></body></html>
`;
const TALL_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>tall</title></head>
<body><div id="app-probe">app-ok</div><div style="height:2400px"></div></body></html>
`;

const closedPort = await reserveClosedPort();
const fixture = await startLoopbackFixture({
  redirects: { "/redirect/link-local": LINK_LOCAL },
  responses: {
    ...checkFixtureResponses(closedPort),
    "/app": () => ({ body: APP_HTML }),
    "/tall": () => ({ body: TALL_HTML }),
  },
});

let workDir: string;
let shared: BrowserSession | undefined;
let unavailable: string | undefined;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "u7agent-commands-"));
  try {
    // テスト 1 ファイルで 1 つのセッションを使い回すため、CLI 1 回ぶんの期限より長く持つ
    shared = await openBrowserSession({ deadlineMs: 10 * 60_000, log: () => {} });
  } catch (error) {
    unavailable = (error as Error).message;
  }
});

after(async () => {
  await shared?.close();
  await fixture.close();
  await rm(workDir, { recursive: true, force: true });
});

function requireSession(t: TestContext): BrowserSession | undefined {
  if (shared) return shared;
  t.skip(`Playwright のブラウザが無いため skip します: ${unavailable}`);
  return undefined;
}

function expectItem(report: CheckReport, category: CheckCategory, pattern: RegExp): void {
  assert.ok(
    report.items.some((item) => item.category === category && pattern.test(item.text)),
    `[${category}] ${pattern} がありません:\n${formatCheckReport(report)}`,
  );
}

test("shot は既定 viewport の PNG を保存し、同名のときは上書きしない", async (t) => {
  const session = requireSession(t);
  if (!session) return;

  const first = await runShot(session, `${fixture.origin}/app`, "shots/app.png", { cwd: workDir });
  assert.equal(first.path, "shots/app.png", "返すのは要求したパスではなく実際の cwd 相対パス");
  assert.equal(first.absolutePath, join(workDir, "shots", "app.png"));
  const firstImage = await readFile(first.absolutePath);
  assert.deepEqual(pngSize(firstImage), { width: 1280, height: 720 });

  const second = await runShot(session, `${fixture.origin}/app`, "shots/app.png", { cwd: workDir });
  assert.equal(second.path, "shots/app-1.png");
  const third = await runShot(session, `${fixture.origin}/app`, "shots/app.png", { cwd: workDir });
  assert.equal(third.path, "shots/app-2.png", "連番を進める");
  assert.deepEqual(await readFile(first.absolutePath), firstImage, "既存の画像は書き換えない");
  assert.deepEqual(
    (await readdir(join(workDir, "shots"))).sort(),
    ["app-1.png", "app-2.png", "app.png"],
    "cwd へ残すのは明示した画像だけ",
  );
});

test("shot は --width / --height と --full-page を反映する", async (t) => {
  if (!shared) {
    t.skip(`Playwright のブラウザが無いため skip します: ${unavailable}`);
    return;
  }
  // viewport はセッションの起動時に決まるため、上書きの検査だけ専用のセッションを使う
  const session = await openBrowserSession({ viewport: { width: 375, height: 667 }, log: () => {} });
  try {
    const view = await runShot(session, `${fixture.origin}/tall`, "mobile.png", { cwd: workDir });
    assert.deepEqual(pngSize(await readFile(view.absolutePath)), { width: 375, height: 667 });

    const full = await runShot(session, `${fixture.origin}/tall`, "mobile-full.png", {
      cwd: workDir,
      fullPage: true,
    });
    const size = pngSize(await readFile(full.absolutePath));
    assert.equal(size.width, 375);
    assert.ok(size.height > 667, `fullPage の高さが viewport を超えていません: ${size.height}`);
  } finally {
    await session.close();
  }
});

test("shot と dom はループバック以外と最初に拒否する", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  await assert.rejects(runShot(session, "http://192.0.2.1/", "denied.png", { cwd: workDir }), ReachDeniedError);
  await assert.rejects(runDom(session, "http://192.0.2.1/"), ReachDeniedError);
  // ループバックから外部へ redirect された場合も、403 のエラーページを成果物にしない
  await assert.rejects(
    runShot(session, fixture.redirect("/redirect/link-local"), "denied.png", { cwd: workDir }),
    ReachDeniedError,
  );
});

test("shot は待ち時間の指定を反映し、現れない selector では保存しない", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const started = Date.now();
  await runShot(session, `${fixture.origin}/app`, "waited.png", { cwd: workDir, waitForTimeoutMs: 300 });
  assert.ok(Date.now() - started >= 300, "--wait-for-timeout の分だけ待つ");

  await assert.rejects(
    runShot(session, `${fixture.origin}/app`, "never.png", {
      cwd: workDir,
      waitForSelector: "#never-appears",
      waitTimeoutMs: 500,
    }),
    /Timeout/,
  );
  await assert.rejects(readFile(join(workDir, "never.png")), /ENOENT/, "失敗した撮影はファイルを残さない");
});

test("dom はレンダリング後の HTML を返し、上限で切り詰める", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const result = await runDom(session, `${fixture.origin}/app`);
  assert.match(result.html, /app-probe/);
  assert.match(result.html, /日本語のラベルと絵文字/);
  assert.equal(result.truncated, false);

  const capped = await runDom(session, `${fixture.origin}/app`, { maxBytes: 8 });
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.html) <= 8);
});

test("check は 404 と 500 を http の失敗として分類する", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const notFound = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.status404}`, { settleMs: 0 });
  expectItem(notFound, "http", /→ 404/);
  assert.equal(checkExitCode(notFound), EXIT_VALIDATION_FAILED, "load が成功しても 404 は検証成功にしない");

  const serverError = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.status500}`, { settleMs: 0 });
  expectItem(serverError, "http", /→ 500/);
  assert.equal(checkExitCode(serverError), EXIT_VALIDATION_FAILED);
});

test("check は uncaught exception と通信失敗を別分類で集める", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const pageError = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.pageerror}`, { settleMs: 0 });
  expectItem(pageError, "pageerror", /fixture-pageerror/);

  const requestFailed = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.requestFailed}`, {
    settleMs: 100,
  });
  expectItem(requestFailed, "requestfailed", /ERR_CONNECTION_REFUSED/);
  assert.equal(checkExitCode(requestFailed), EXIT_VALIDATION_FAILED);
});

test("check はアイコンの 404 を警告にして失敗に数えない", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const report = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.iconWarning}`, { settleMs: 100 });
  assert.equal(report.warnings, 1, formatCheckReport(report));
  assert.equal(report.failures, 0, formatCheckReport(report));
  assert.equal(checkExitCode(report), 0);
});

test("check は ready selector を待ってから収集し、現れなければ ready の失敗にする", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const late = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.late}`, {
    readySelector: "#late",
    readyTimeoutMs: 3000,
    settleMs: 500,
  });
  expectItem(late, "pageerror", /fixture-late/);

  const missing = await runCheck(session, `${fixture.origin}/app`, {
    readySelector: "#never-appears",
    readyTimeoutMs: 500,
    settleMs: 0,
  });
  expectItem(missing, "ready", /ready selector が現れません: #never-appears \(500 ms\)/);
  assert.equal(checkExitCode(missing), EXIT_VALIDATION_FAILED);

  // selector の書き間違いは待ち外れと区別する (原因が違うと直し方も違う)
  const invalid = await runCheck(session, `${fixture.origin}/app`, {
    readySelector: "<bad selector",
    readyTimeoutMs: 500,
    settleMs: 0,
  });
  expectItem(invalid, "ready", /ready selector を待てません: <bad selector \(page\.waitForSelector: Unexpected token/);
  assert.equal(checkExitCode(invalid), EXIT_VALIDATION_FAILED);
});

test("check はループバックの WS の成功を失敗にしない", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const report = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.webSocket}`, {
    readySelector: "#ws-ok",
    readyTimeoutMs: 3000,
    settleMs: 0,
  });
  assert.equal(report.failures, 0, formatCheckReport(report));
  assert.equal(checkExitCode(report), 0);
});

test("check はループバック以外の URL と link-local への redirect を navigation の失敗にする", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const denied = await runCheck(session, "http://192.0.2.1/", { settleMs: 0 });
  expectItem(denied, "navigation", /ループバック以外へは通信しません/);
  assert.equal(checkExitCode(denied), EXIT_VALIDATION_FAILED);

  const redirected = await runCheck(session, fixture.redirect("/redirect/link-local"), { settleMs: 0 });
  expectItem(redirected, "navigation", /ループバック以外へは通信しません/);
  assert.equal(checkExitCode(redirected), EXIT_VALIDATION_FAILED);
});

test("check は遷移の timeout を navigation の失敗にする", async (t) => {
  const session = requireSession(t);
  if (!session) return;
  const report = await runCheck(session, `${fixture.origin}${CHECK_FIXTURE_PATHS.hang}`, {
    navigationTimeoutMs: 700,
    settleMs: 0,
  });
  expectItem(report, "navigation", /Timeout/);
  assert.equal(checkExitCode(report), EXIT_VALIDATION_FAILED);
});
