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
  type CheckReport,
} from "../src/browser/check";
import { EXIT_OK, EXIT_VALIDATION_FAILED } from "../src/browser/exit-codes";

function reportOf(recorder: ReturnType<typeof createCheckRecorder>): CheckReport {
  return recorder.report({ url: "http://127.0.0.1:3000/", durationMs: 12 });
}

test("同じ内容は 1 項目へまとめ、件数を数える", () => {
  const recorder = createCheckRecorder();
  recorder.record("console", "same error");
  recorder.record("console", "same error");
  recorder.record("pageerror", "same error", { warning: true });
  const report = reportOf(recorder);
  assert.equal(report.items.length, 2, "分類が違えば別の項目にする");
  assert.equal(report.items[0]?.count, 2);
  assert.equal(report.items[1]?.count, 1);
  assert.equal(report.failures, 1);
  assert.equal(report.warnings, 1);
});

test("件数の上限に達したら収集を打ち切り、繰り返しは上限まで数える", () => {
  const logs: string[] = [];
  const recorder = createCheckRecorder({ maxItems: 2, log: (message) => logs.push(message) });
  recorder.record("http", "a");
  recorder.record("http", "b");
  recorder.record("http", "c");
  recorder.record("http", "d");
  recorder.record("http", "a");
  const report = reportOf(recorder);
  assert.equal(report.items.length, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.items[0]?.count, 2, "上限に達した後も既出の項目は数える");
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
  assert.match(text, /check: 検証失敗 \(失敗 3 \/ 警告 1, 12 ms\) http:\/\/127\.0\.0\.1:3000\/\n$/);

  const empty = formatCheckReport(createCheckRecorder().report({ url: "http://127.0.0.1/", durationMs: 1 }));
  assert.equal(empty, "check: 検証成功 (失敗 0 / 警告 0, 1 ms) http://127.0.0.1/\n");

  const truncated = formatCheckReport({ ...reportOf(recorder), truncated: true });
  assert.match(truncated, /件数の上限に達したため残りを省略しました/);
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
