// `check` の収集と分類 (server/src/browser/check.ts) のうち、ブラウザに依存しない契約を検証する。
// 上限・重複の畳み方・警告の扱いは、実ブラウザのテストでは入力を作りにくいため、ここで境界まで固定する。

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkExitCode,
  createCheckRecorder,
  formatCheckReport,
  isBrowserConsoleNoise,
  isDeniedByProxy,
  isIconUrl,
  isWarningHttpResponse,
  runCheck,
  type CheckReport,
} from "../src/browser/check";
import { EXIT_OK, EXIT_VALIDATION_FAILED } from "../src/browser/exit-codes";
import { MAX_CHECK_OUTPUT_BYTES } from "../src/browser/limits";
import type { BrowserSession } from "../src/browser/session";

function reportOf(recorder: ReturnType<typeof createCheckRecorder>): CheckReport {
  return recorder.report({ url: "http://127.0.0.1:3000/", durationMs: 12 });
}

/**
 * `runCheck` が触る範囲だけを持つ偽の session。期限でブラウザが閉じた状況は
 * settle の待ち (`waitForTimeout`) が終わるまでに `timedOut` が true になることで作る。
 */
function fakeSession(options: { timedOut?: boolean } = {}): BrowserSession {
  const state = { timedOut: false };
  const page = {
    on: () => page,
    off: () => page,
    goto: async () => null,
    url: () => "http://127.0.0.1:3000/",
    waitForTimeout: async () => {
      state.timedOut = options.timedOut ?? false;
    },
  };
  const context = { on: () => context, off: () => context };
  return {
    page,
    context,
    denials: [],
    get timedOut() {
      return state.timedOut;
    },
  } as unknown as BrowserSession;
}

test("同じ内容は 1 項目へまとめ、件数は発生ごとに数える", () => {
  const recorder = createCheckRecorder();
  recorder.record("console", "same error");
  recorder.record("console", "same error");
  recorder.record("pageerror", "same error", { warning: true });
  const report = reportOf(recorder);
  assert.equal(report.items.length, 2, "分類が違えば別の項目にする");
  assert.equal(report.items[0]?.count, 2);
  assert.equal(report.items[1]?.count, 1);
  assert.equal(report.failures, 2, "失敗は発生した回数で数える");
  assert.equal(report.warnings, 1);
});

test("詳細の上限に達しても、打ち切った分の失敗を成否の件数へ数える", () => {
  const logs: string[] = [];
  const recorder = createCheckRecorder({ maxItems: 2, log: (message) => logs.push(message) });
  recorder.record("http", "a");
  recorder.record("http", "b");
  recorder.record("pageerror", "c", { warning: true });
  recorder.record("pageerror", "d");
  recorder.record("http", "a");
  const report = reportOf(recorder);
  assert.equal(report.items.length, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.items[0]?.count, 2, "上限に達した後も既出の項目は数える");
  assert.equal(report.failures, 4, "詳細を保持しなかった失敗も数える");
  assert.equal(report.warnings, 1, "詳細を保持しなかった警告も数える");
  assert.equal(checkExitCode(report), EXIT_VALIDATION_FAILED);
  assert.equal(logs.length, 1, "案内は 1 回だけ出す");
  assert.match(logs[0] ?? "", /上限 \(2 件\)/);
});

test("1 項目の文字数は上限で切り詰める", () => {
  const recorder = createCheckRecorder({ maxTextChars: 6 });
  recorder.record("console", "あいうえお");
  const report = reportOf(recorder);
  assert.deepEqual(report.items[0]?.text, "あい");
  assert.equal(report.items[0]?.count, 1);
});

test("アイコンの URL だけを警告として扱う", () => {
  for (const url of [
    "http://127.0.0.1:3000/favicon.ico",
    "http://127.0.0.1:3000/assets/favicon.svg",
    "http://127.0.0.1:3000/FAVICON.PNG",
    "http://127.0.0.1:3000/apple-touch-icon.png",
    "http://127.0.0.1:3000/apple-touch-icon-120x120.png",
  ]) {
    assert.equal(isIconUrl(url), true, url);
  }
  for (const url of [
    "http://127.0.0.1:3000/favicon.js",
    "http://127.0.0.1:3000/apple-touch-icon.css",
    "http://127.0.0.1:3000/icons/app.svg",
    "http://127.0.0.1:3000/",
    "not a url",
  ]) {
    assert.equal(isIconUrl(url), false, url);
  }
});

test("アイコンの URL を警告にしてよいのは 404 のときだけ", () => {
  assert.equal(isWarningHttpResponse(404, "http://127.0.0.1:3000/favicon.svg"), true);
  assert.equal(isWarningHttpResponse(404, "http://127.0.0.1:3000/apple-touch-icon.png"), true);
  assert.equal(isWarningHttpResponse(500, "http://127.0.0.1:3000/favicon.svg"), false, "アイコンの 500 は失敗");
  assert.equal(isWarningHttpResponse(403, "http://127.0.0.1:3000/favicon.svg"), false);
  assert.equal(isWarningHttpResponse(404, "http://127.0.0.1:3000/app.js"), false, "アイコン以外の 404 は失敗");
});

test("ブラウザ自身が出す読み込み失敗の console.error は数えない", () => {
  assert.equal(isBrowserConsoleNoise("Failed to load resource: net::ERR_CONNECTION_REFUSED"), true);
  assert.equal(isBrowserConsoleNoise("Failed to load resource: the server responded with a status of 404"), true);
  assert.equal(isBrowserConsoleNoise("app error"), false);
  assert.equal(isBrowserConsoleNoise("Failed to fetch"), false);
});

test("proxy が拒否した宛先を URL から見分ける", () => {
  assert.equal(isDeniedByProxy([], "http://192.0.2.1/x.js"), false);
  assert.equal(isDeniedByProxy(["http://192.0.2.1/x.js"], "http://192.0.2.1/other.js"), true);
  assert.equal(isDeniedByProxy(["192.0.2.1:443"], "https://192.0.2.1/"), true);
  assert.equal(isDeniedByProxy(["http://192.0.2.1/x.js"], "http://127.0.0.1:3000/x.js"), false);
  assert.equal(isDeniedByProxy(["http://192.0.2.1/x.js"], "not a url"), false);
});

test("出力は分類ごとに 1 行で出し、要約に検証の結果を出す", () => {
  const recorder = createCheckRecorder();
  recorder.record("navigation", "ループバック以外へは通信しません: http://192.0.2.1/");
  recorder.record("pageerror", "Error: boom");
  recorder.record("http", "GET http://127.0.0.1:3000/missing → 404");
  recorder.record("http", "GET http://127.0.0.1:3000/favicon.svg → 404", { warning: true });
  const text = formatCheckReport(reportOf(recorder));
  assert.match(text, /^\[失敗\] navigation: ループバック以外へは通信しません/);
  assert.match(text, /\[失敗\] pageerror: Error: boom/);
  assert.match(text, /\[警告\] http: GET http:\/\/127\.0\.0\.1:3000\/favicon\.svg → 404/);
  assert.match(text, /check: 検証失敗 \(失敗 3 件 \/ 警告 1 件, 12 ms\) http:\/\/127\.0\.0\.1:3000\/\n$/);

  const empty = formatCheckReport(createCheckRecorder().report({ url: "http://127.0.0.1/", durationMs: 1 }));
  assert.equal(empty, "check: 検証成功 (失敗 0 件 / 警告 0 件, 1 ms) http://127.0.0.1/\n");

  const truncated = formatCheckReport({ ...reportOf(recorder), truncated: true });
  assert.match(truncated, /詳細の上限に達したため以降の詳細は省略しました/);
});

test("長い URL でも出力は上限に収まり、要約の URL は切り詰める", () => {
  const url = `http://localhost/?q=${"x".repeat(70_000)}`;
  const text = formatCheckReport(createCheckRecorder().report({ url, durationMs: 5 }));
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(bytes <= MAX_CHECK_OUTPUT_BYTES, `出力が上限を超えています: ${bytes} bytes`);
  assert.match(text, /^check: 検証成功 \(失敗 0 件 \/ 警告 0 件, 5 ms\) http:\/\/localhost\/\?q=x+/);
  assert.match(text, /\.\.\.\n$/, "切ったことを末尾の ... で示す");
  assert.ok(!text.includes("x".repeat(70_000)), "URL をそのまま埋め込まない");
});

test("検証失敗だけが終了コード 1 になり、警告は 0 のままにする", () => {
  const clean = createCheckRecorder();
  clean.record("http", "GET http://127.0.0.1/favicon.svg → 404", { warning: true });
  assert.equal(checkExitCode(reportOf(clean)), EXIT_OK);

  const failed = createCheckRecorder();
  failed.record("http", "GET http://127.0.0.1/missing → 404");
  assert.equal(checkExitCode(reportOf(failed)), EXIT_VALIDATION_FAILED);
  assert.equal(EXIT_VALIDATION_FAILED, 1);
});

test("収集窓の途中で期限が切れたら、レポートを返さない", async () => {
  await assert.rejects(
    runCheck(fakeSession({ timedOut: true }), "http://127.0.0.1:3000/", { settleMs: 1 }),
    /期限/,
    "完走していない収集を検証成功として返さない",
  );
  // 期限が切れていない通常の呼び出しはレポートを返す (遷移失敗は検証失敗 1 のまま扱える)
  const report = await runCheck(fakeSession(), "http://127.0.0.1:3000/", { settleMs: 1 });
  assert.equal(report.failures, 0);
  assert.equal(checkExitCode(report), EXIT_OK);
});
