// `run` の契約を実ブラウザで検証する。スクリプト (作業領域の .mjs = 任意コード) が受け取れるのは
// ラッパーが作った page / context の引数だけで、ドライバの解決とブラウザの起動はラッパー側にある。
// 対話 (クリック / 入力 / 待機) と外部到達の既定は、スクリプトが書いたファイルではなく
// セッションの page / context から読める観測結果でも確かめる。
// CLI を実プロセスで走らせる検査 (終了コード・期限超過・SIGKILL 後の回収) も、置き場 (/tmp) と
// 同時実行の枠を他のファイルと共有していて順序が要るため、このファイルに置いて直列に走らせる。
// ブラウザが無い環境では skip する (イメージの probe が同梱物を別途検査する)。

import "../src/browser/environment";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, test, type TestContext } from "node:test";
import { chromium } from "playwright-core";
import { startLoopbackFixture } from "../src/browser/fixture";
import { BROWSER_ARGUMENTS } from "../src/browser/policy";
import { loadRunEntry, runScript, validateScriptName, type RunOutcome } from "../src/browser/run";
import { openBrowserSession, type BrowserSession } from "../src/browser/session";
import { BROWSER_TEMP_ROOT } from "../src/browser/temp";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX_LOADER = join(SERVER_DIR, "node_modules", "tsx", "dist", "loader.mjs");
const CLI = join(SERVER_DIR, "src", "browser", "cli.ts");

/** 対話の入力。ボタンで数える / 入力で大文字を映す / 遅れて出る要素を待つ、の 3 つを 1 ページで見る */
const APP_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>run fixture</title></head>
<body>
  <div id="count">0</div>
  <button id="inc" type="button">+1</button>
  <input id="name">
  <div id="echo"></div>
  <script>
    let count = 0;
    document.getElementById("inc").addEventListener("click", () => {
      count += 1;
      document.getElementById("count").textContent = String(count);
    });
    document.getElementById("name").addEventListener("input", (event) => {
      document.getElementById("echo").textContent = event.target.value.toUpperCase();
    });
    setTimeout(() => {
      const ready = document.createElement("div");
      ready.id = "ready";
      ready.textContent = "ready";
      document.body.append(ready);
    }, 200);
  </script>
</body></html>
`;

const fixture = await startLoopbackFixture({ responses: { "/app": () => ({ body: APP_HTML }) } });

let workDir: string;
let unavailable: string | undefined;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "u7agent-run-"));
  unavailable = await checkBrowser();
});

after(async () => {
  await fixture.close();
  await rm(workDir, { recursive: true, force: true });
});

/** 可用性は枠を使わずに確かめる (session を開くと他のブラウザテストと同時実行の上限を争う) */
async function checkBrowser(): Promise<string | undefined> {
  try {
    const browser = await chromium.launch({ headless: true, args: [...BROWSER_ARGUMENTS] });
    await browser.close();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function skipWithoutBrowser(t: TestContext): boolean {
  if (!unavailable) return false;
  t.skip(`Playwright のブラウザが無いため skip します: ${unavailable}`);
  return true;
}

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_TMPDIR = process.env.TMPDIR;

/**
 * session は HOME / TMPDIR を呼び出しごとの領域へ差し替える。閉じても値は残るため、CLI を spawn する前に元へ戻す
 * (削除済みの領域を子プロセスの tsx が作り直すと、置き場に回収対象でない残骸が残る)。
 */
function restoreBrowserEnv(): void {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = ORIGINAL_TMPDIR;
}

/** テストごとに 1 つのセッションを開く (ファイルで共有すると枠を長時間握り、他のファイルと合わせて上限に当たる) */
async function runInSession(t: TestContext, body: (session: BrowserSession) => Promise<void>): Promise<void> {
  if (skipWithoutBrowser(t)) return;
  const session = await openBrowserSession({ deadlineMs: 60_000, log: () => {} });
  try {
    await body(session);
  } finally {
    await session.close();
    restoreBrowserEnv();
  }
}

/** 作業領域の .mjs を作る。スクリプトはこのパスから import される (bare import の解決の基準) */
async function writeScript(name: string, source: string): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, source);
  return path;
}

function expectOk(outcome: RunOutcome): void {
  assert.equal(outcome.status, "ok", outcome.status === "failed" ? outcome.error.message : outcome.status);
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** CLI を実プロセスで走らせる。cwd は作業領域にする (成果物と保存先の基準) */
function startCli(args: readonly string[]): { child: ChildProcess; result: Promise<CliRun> } {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const result = new Promise<CliRun>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  // 失敗した検査が result を待たずに終わっても、unhandled rejection を残さない
  result.catch(() => undefined);
  return { child, result };
}

/** すでに解決しているときだけ値を返す (未解決なら undefined)。起動できなかった理由を出すのに使う */
function settled<T>(promise: Promise<T>): Promise<T | undefined> {
  return Promise.race([promise, delay(0).then(() => undefined)]);
}

/** 期限や kill の検証でテストが止まらないよう上限を設ける。超えたら kill して失敗にする */
async function waitForExit(child: ChildProcess, result: Promise<CliRun>, timeoutMs: number): Promise<CliRun> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const run = await result;
    assert.equal(timedOut, false, `CLI が ${timeoutMs} ms 以内に終わりませんでした: ${run.stderr}`);
    return run;
  } finally {
    clearTimeout(timer);
  }
}

async function runCli(args: readonly string[], timeoutMs = 60_000): Promise<CliRun> {
  const { child, result } = startCli(args);
  return waitForExit(child, result, timeoutMs);
}

/** 置き場の名前は所有者 (pid と起動時刻) を表すため、自分が起こした CLI の pid で始まる名前を探す */
async function findCallDir(pid: number): Promise<string | undefined> {
  const entries = await readdir(BROWSER_TEMP_ROOT).catch(() => [] as string[]);
  const found = entries.find((entry) => entry.startsWith(`${pid}-`));
  return found === undefined ? undefined : join(BROWSER_TEMP_ROOT, found);
}

async function waitForCallDir(child: ChildProcess, result: Promise<CliRun>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dir = await findCallDir(child.pid as number);
    if (dir) return dir;
    if (Date.now() > deadline) {
      const finished = await settled(result);
      throw new Error(
        `CLI (pid ${child.pid}) の一時領域ができません${finished ? `: ${finished.stderr}` : " (実行中のまま)"}`,
      );
    }
    await delay(50);
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await stat(path).catch(() => undefined)) === undefined) {
    if (Date.now() > deadline) throw new Error(`ファイルが現れません: ${path}`);
    await delay(50);
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

test("run は既定 export へ渡した page / context でクリック・入力・待機できる", async (t) => {
  const result = join(workDir, "interaction.json");
  await runInSession(t, async (session) => {
    const script = await writeScript(
      "interaction.mjs",
      `import { writeFileSync } from "node:fs";
export default async function ({ page, context }) {
  await page.goto(${JSON.stringify(`${fixture.origin}/app`)});
  await page.click("#inc");
  await page.click("#inc");
  await page.fill("#name", "u7agent");
  await page.waitForSelector("#ready");
  const second = await context.newPage();
  await second.goto(${JSON.stringify(fixture.origin)});
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({
    count: await page.textContent("#count"),
    echo: await page.textContent("#echo"),
    ready: await page.textContent("#ready"),
    pagesWithSecond: context.pages().length,
  }));
  await second.close();
}
`,
    );
    expectOk(await runScript(session, script));
    assert.deepEqual(JSON.parse(await readFile(result, "utf8")), {
      count: "2",
      echo: "U7AGENT",
      ready: "ready",
      pagesWithSecond: 2,
    });
    // 渡されたのはそのセッションの page / context そのもの (別のブラウザを起動していない)
    assert.equal(session.page.url(), `${fixture.origin}/app`);
    assert.equal(session.context.pages().length, 1, "スクリプトが閉じた page を残さない");
  });
});

test("スクリプトは bare import でドライバを解決できない", async () => {
  // 作業領域の .mjs は自分の位置から解決する。ラッパーの node_modules は経路に入らない
  const script = await writeScript(
    "bare-import.mjs",
    `import { chromium } from "playwright-core";\nexport default () => chromium.launch();\n`,
  );
  await assert.rejects(loadRunEntry(script), /Cannot find package 'playwright-core'/);
});

test("読み込めないスクリプトはブラウザを起動する前に落とす", async () => {
  assert.equal(validateScriptName("check.mjs"), "check.mjs");
  assert.throws(() => validateScriptName(""), /空です/);
  assert.throws(() => validateScriptName("check.ts"), /スクリプトは \.mjs で指定してください/);
  await assert.rejects(loadRunEntry("missing.mjs", workDir), /スクリプトを読めません/);
  const notFunction = await writeScript("not-function.mjs", "export default 42;\n");
  await assert.rejects(loadRunEntry(notFunction), /既定 export が関数ではありません/);
  const directory = join(workDir, "a-directory.mjs");
  await mkdir(directory, { recursive: true });
  await assert.rejects(loadRunEntry(directory), /スクリプトを読めません/);
});

test("スクリプトの例外は失敗として返し、セッションは閉じない", async (t) => {
  await runInSession(t, async (session) => {
    const script = await writeScript(
      "failing.mjs",
      `export default async function ({ page }) {\n  await page.goto(${JSON.stringify(fixture.origin)});\n  throw new Error("script-boom");\n}\n`,
    );
    const outcome = await runScript(session, script);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.message : "", "script-boom");
    assert.equal(session.page.isClosed(), false, "スクリプトの失敗でセッションを閉じない");

    const afterFailure = await writeScript(
      "after-failure.mjs",
      `export default async ({ page }) => { await page.goto(${JSON.stringify(fixture.origin)}); };\n`,
    );
    expectOk(await runScript(session, afterFailure));
  });
});

test("run でも外部到達のポリシーは既定で適用される", async (t) => {
  const result = join(workDir, "denied.txt");
  await runInSession(t, async (session) => {
    const script = await writeScript(
      "denied.mjs",
      `import { writeFileSync } from "node:fs";
export default async function ({ page }) {
  const outcome = await page.goto("http://192.0.2.1/", { timeout: 10_000 }).then(
    (response) => "status:" + (response ? response.status() : "none"),
    (error) => "error:" + error.message,
  );
  writeFileSync(${JSON.stringify(result)}, outcome);
}
`,
    );
    expectOk(await runScript(session, script));
  });
  // route 層が abort する (ERR_BLOCKED_BY_CLIENT)。route の無い経路では proxy の 403 になる (どちらも外へ出ない)
  assert.match(await readFile(result, "utf8"), /status:403|ERR_BLOCKED_BY_CLIENT/, "外部到達が拒否される");
});

test("run はポリシーの解除を妨げない", async (t) => {
  const result = join(workDir, "unrouted.txt");
  await runInSession(t, async (session) => {
    // 標準経路の route を外して自分で張り直す。任意コードなので解除できる (境界の実効性は標準経路に限る)
    const script = await writeScript(
      "unroute.mjs",
      `import { writeFileSync } from "node:fs";
export default async function ({ page, context }) {
  await context.unroute("**");
  await page.route("**/app", (route) => route.fulfill({ body: "<div id='stub'>stub</div>" }));
  await page.goto(${JSON.stringify(`${fixture.origin}/app`)});
  writeFileSync(${JSON.stringify(result)}, await page.textContent("#stub"));
}
`,
    );
    expectOk(await runScript(session, script));
  });
  assert.equal(await readFile(result, "utf8"), "stub");
});

/**
 * 期限付きのセッションでスクリプトを 1 回実行し、打ち切りと回収まで確かめる。
 * テスト自身のプロセスで動かすため、スクリプトはハンドル (タイマー) を持たない待機にする
 * (タイマーを掴む場合の打ち切りは CLI の検査で見る)。
 */
async function runUntilDeadline(script: string): Promise<RunOutcome> {
  const session = await openBrowserSession({ deadlineMs: 2000, log: () => {} });
  const dirs = session.dirs;
  let outcome: RunOutcome;
  try {
    outcome = await runScript(session, script);
  } finally {
    // スクリプトが例外を握りつぶした場合は打ち切りの判定が回収より先に返るため、ここで回収の完了を待つ
    await session.close();
    restoreBrowserEnv();
  }
  assert.equal(session.timedOut, true, "期限超過で打ち切る");
  assert.equal(session.page.isClosed(), true, "ブラウザを閉じる");
  await assert.rejects(stat(dirs.root), /ENOENT/, "一時領域を回収する");
  return outcome;
}

test("期限超過ではスクリプトを打ち切り、ブラウザと一時領域を回収する", async (t) => {
  if (skipWithoutBrowser(t)) return;
  const script = await writeScript("hanging.mjs", `export default function () {\n  return new Promise(() => {});\n}\n`);
  assert.equal((await runUntilDeadline(script)).status, "interrupted");
});

test("期限超過は読み込み中のトップレベル待機も打ち切る", async (t) => {
  if (skipWithoutBrowser(t)) return;
  // モジュールの評価が終わらないため、読み込みを待ってから競合を始めると CLI が終わらない
  const started = join(workDir, "import-started.txt");
  const entered = join(workDir, "import-entered.txt");
  const script = await writeScript(
    "import-hang.mjs",
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
await new Promise(() => {});
export default function () {
  writeFileSync(${JSON.stringify(entered)}, "entered");
}
`,
  );
  assert.equal((await runUntilDeadline(script)).status, "interrupted");
  assert.equal(await readFile(started, "utf8"), "started", "モジュールの評価は始まっている");
  await assert.rejects(stat(entered), /ENOENT/, "打ち切った後はスクリプトを始めない");
});

test("期限超過はスクリプトが例外を握りつぶしても成功にしない", async (t) => {
  if (skipWithoutBrowser(t)) return;
  // 期限でブラウザを閉じたときの reject を catch して正常 return する経路で、成功へ変わらないこと
  const caught = join(workDir, "caught-deadline.txt");
  const script = await writeScript(
    "caught-deadline.mjs",
    `import { writeFileSync } from "node:fs";
export default async function ({ page }) {
  try {
    await page.waitForTimeout(60_000);
  } catch {}
  writeFileSync(${JSON.stringify(caught)}, "caught");
}
`,
  );
  assert.equal((await runUntilDeadline(script)).status, "interrupted");
  assert.equal(await readFile(caught, "utf8"), "caught", "スクリプトは catch して正常 return している");
});

test("run は成功で 0、スクリプトの例外で 1 を返し、スクリプトの出力をそのまま出す", async (t) => {
  if (skipWithoutBrowser(t)) return;
  const dataUrl = "data:text/html,<div id=probe>ok</div>";
  const ok = await writeScript(
    "ok.mjs",
    `export default async function ({ page }) {
  await page.goto(${JSON.stringify(dataUrl)});
  process.stdout.write("script-output:" + (await page.textContent("#probe")) + "\\n");
}
`,
  );
  const success = await runCli(["run", ok]);
  assert.equal(success.code, 0, success.stderr);
  assert.match(success.stdout, /script-output:ok/);

  const failed = await writeScript(
    "cli-failed.mjs",
    `export default async () => {\n  throw new Error("script-boom");\n};\n`,
  );
  const failure = await runCli(["run", failed]);
  assert.equal(failure.code, 1, failure.stderr);
  assert.match(failure.stderr, /スクリプトが失敗しました: script-boom/);
});

test("読み込めないスクリプトは 2 を返し、拡張子の誤りはブラウザを起動しない", async (t) => {
  if (skipWithoutBrowser(t)) return;
  const extension = await runCli(["run", "check.ts"]);
  assert.equal(extension.code, 2, extension.stderr);
  assert.match(extension.stderr, /スクリプトは \.mjs で指定してください/);
  assert.equal(extension.stderr.includes("同時実行の枠"), false, "引数の解析で落ちる (ブラウザを起動しない)");

  // 読み込みの失敗は、期限との競合に入れても検証失敗 (1) ではなく起動・入力エラー (2) として返す
  const missing = await runCli(["run", "missing.mjs"]);
  assert.equal(missing.code, 2, missing.stderr);
  assert.match(missing.stderr, /スクリプトを読めません: missing.mjs/);
});

test("期限超過ではプロセスが終わり、一時領域が残らない", async (t) => {
  if (skipWithoutBrowser(t)) return;
  const scripts = [
    // 本文でタイマーを掴んで返らない (回収後も外側の kill 無しで終わること)
    await writeScript(
      "cli-hanging.mjs",
      `export default function () {\n  setInterval(() => {}, 50);\n  return new Promise(() => {});\n}\n`,
    ),
    // 読み込み中のトップレベル待機 (モジュールの評価が終わらない)
    await writeScript(
      "cli-import-hang.mjs",
      `setInterval(() => {}, 50);\nawait new Promise(() => {});\nexport default () => {};\n`,
    ),
    // 期限で閉じたことによる reject を catch して正常 return する
    await writeScript(
      "cli-caught-deadline.mjs",
      `export default async function ({ page }) {\n  try {\n    await page.waitForTimeout(60_000);\n  } catch {}\n};
`,
    ),
  ];
  for (const script of scripts) {
    const { child, result } = startCli(["run", script, "--deadline-ms", "2000"]);
    try {
      const dir = await waitForCallDir(child, result, 20_000);
      // 上限を過ぎたら kill して失敗にする (外側の kill が要る時点で契約違反)
      const run = await waitForExit(child, result, 15_000);
      assert.equal(run.code, 2, `${script}: ${run.stderr}`);
      // 期限は起動中にも実行中にも当たる。起動中は CallDeadlineError の「超えたため中断しました」、
      // 実行中は interruptRun の「超えました」になり、どちらも正当な期限超過のログ
      assert.match(run.stderr, /期限 \(2000 ms\) を超え(?:ました|たため中断しました)/);
      await assert.rejects(stat(dir), /ENOENT/, `${script}: 期限超過の一時領域が残っている`);
    } finally {
      child.kill("SIGKILL");
    }
  }
});

test("SIGKILL で残った一時領域は次の起動の掃除で回収される", async (t) => {
  if (skipWithoutBrowser(t)) return;
  const ready = join(workDir, "killed-ready.txt");
  const script = await writeScript(
    "cli-blocking.mjs",
    `import { writeFileSync } from "node:fs";
export default async function ({ page }) {
  await page.goto("data:text/html,<div id=probe>ready</div>");
  writeFileSync(${JSON.stringify(ready)}, "ready");
  setInterval(() => {}, 50);
  return new Promise(() => {});
}
`,
  );
  const { child, result } = startCli(["run", script, "--deadline-ms", "60000"]);
  try {
    const dir = await waitForCallDir(child, result, 20_000);
    await waitForFile(ready, 30_000);

    // 外側の abort はプロセス群へ SIGKILL を送るため finally は走らない。直後の残存は許容する
    child.kill("SIGKILL");
    assert.equal(await exists(dir), true, "SIGKILL 直後は一時領域が残る (回収は次の起動)");
    const killed = await waitForExit(child, result, 15_000);
    assert.equal(killed.code, null);

    // 次の起動時の掃除が、終了済みと確認できる置き場を回収する
    const cleanup = await runCli(["dom", "data:text/html,cleanup"]);
    assert.equal(cleanup.code, 0, cleanup.stderr);
    assert.match(cleanup.stderr, /終了済みの一時領域を回収しました/);
    await assert.rejects(stat(dir), /ENOENT/, "次の起動の掃除で回収されていない");
  } finally {
    child.kill("SIGKILL");
  }
});
