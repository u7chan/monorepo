// 応答メタ情報の整形。
//
// locale に依存しない純関数なので、境界値 (999 / 1.0k / 12k / 1.2M など) を固定値で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  contextGauge,
  formatCost,
  formatDurationMs,
  formatTokens,
  formatTokensPerSecond,
  messageMetaLine,
  messageMetaTitle,
} from "../src/lib/usageFormat";
import type { ContextUsage, MessageMetrics, Usage } from "../src/types";

const USAGE: Usage = {
  input: 8200,
  output: 512,
  cacheRead: 7900,
  cacheWrite: 300,
  reasoning: 128,
  totalTokens: 17_040,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0002, cacheWrite: 0.0001, total: 0.0021 },
};

const METRICS: MessageMetrics = { durationMs: 1800, ttftMs: 900, tokensPerSecond: 42.3 };

test("formatTokens は TUI footer と同じ刻みで丸める", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(10_000), "10k");
  assert.equal(formatTokens(12_300), "12k");
  assert.equal(formatTokens(999_999), "1000k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatTokens(12_000_000), "12M");
});

test("formatDurationMs は ms / s / m を切り替える", () => {
  assert.equal(formatDurationMs(0), "0ms");
  assert.equal(formatDurationMs(999), "999ms");
  assert.equal(formatDurationMs(1000), "1.0s");
  assert.equal(formatDurationMs(1800), "1.8s");
  assert.equal(formatDurationMs(59_900), "59.9s");
  assert.equal(formatDurationMs(60_000), "1.0m");
});

test("formatTokensPerSecond は 100 未満だけ小数第 1 位を出す", () => {
  assert.equal(formatTokensPerSecond(0.5), "0.5 tok/s");
  assert.equal(formatTokensPerSecond(42.34), "42.3 tok/s");
  assert.equal(formatTokensPerSecond(99.9), "99.9 tok/s");
  assert.equal(formatTokensPerSecond(100), "100 tok/s");
  assert.equal(formatTokensPerSecond(120.4), "120 tok/s");
});

test("formatCost は額が小さいほど桁を増やす", () => {
  assert.equal(formatCost(0.0021), "$0.0021");
  assert.equal(formatCost(0.009), "$0.0090");
  assert.equal(formatCost(0.0234), "$0.023");
  assert.equal(formatCost(0.5), "$0.500");
  assert.equal(formatCost(1.5), "$1.50");
  assert.equal(formatCost(12.345), "$12.35");
});

test("常時表示は応答時間 / tok/s / 入出力トークンを並べる", () => {
  assert.equal(messageMetaLine(USAGE, METRICS, false), "1.8s · 42.3 tok/s · ↑8.2k ↓512");
});

test("compact は応答時間と tok/s だけに絞る", () => {
  assert.equal(messageMetaLine(USAGE, METRICS, true), "1.8s · 42.3 tok/s");
});

test("compact は metrics が無ければトークンを出さず、メタ行ごと出さない", () => {
  // compact の判定が metrics の有無に依存すると、usage だけの応答でトークンが出てしまう
  assert.equal(messageMetaLine(USAGE, undefined, true), "");
  const hugeUsage: Usage = { ...USAGE, input: 1_200_000, output: 123_000 };
  assert.equal(messageMetaLine(hugeUsage, undefined, true), "");
  // 応答時間だけあるときはそれを出す
  assert.equal(messageMetaLine(hugeUsage, { durationMs: 1800 }, true), "1.8s");
  // 同じ usage でも desktop はトークンを出す (compact だけの制限)
  assert.equal(messageMetaLine(hugeUsage, undefined, false), "↑1.2M ↓123k");
});

test("報告が無い項目は 0 と偽らずに出さない", () => {
  const zeroUsage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  // usage 非対応プロバイダでも応答時間は BFF 計測値として出る
  assert.equal(messageMetaLine(zeroUsage, METRICS, false), "1.8s · 42.3 tok/s");
  assert.equal(messageMetaLine(undefined, METRICS, false), "1.8s · 42.3 tok/s");
  // 逆に usage だけあって metrics が無い (計測前) ときはトークンだけ出す
  assert.equal(messageMetaLine(USAGE, undefined, false), "↑8.2k ↓512");
  assert.equal(messageMetaLine(undefined, undefined, false), "");
});

test("tok/s が無ければ応答時間だけを出す", () => {
  assert.equal(messageMetaLine(USAGE, { durationMs: 1800 }, false), "1.8s · ↑8.2k ↓512");
  assert.equal(messageMetaLine(USAGE, { durationMs: 1800 }, true), "1.8s");
});

test("ホバー詳細は TTFT / cache / thinking / cost を並べる", () => {
  assert.equal(
    messageMetaTitle(USAGE, METRICS),
    // 1s 未満は ms のまま出す (丸めで 0.0s に見せない)
    "TTFT 900ms / cache R 7.9k W 300 / thinking 128 tok / $0.0021",
  );
});

test("ホバー詳細は報告が無い項目を省き、何も無ければ undefined", () => {
  const bare: Usage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  assert.equal(messageMetaTitle(bare, { durationMs: 1200 }), undefined);
  assert.equal(messageMetaTitle(undefined, { durationMs: 1200, ttftMs: 300 }), "TTFT 300ms");
  assert.equal(messageMetaTitle(undefined, undefined), undefined);
});

test("context ゲージはフィル幅と百分率を返す", () => {
  const gauge = contextGauge({ tokens: 68_000, contextWindow: 200_000, percent: 34 });
  assert.deepEqual(gauge, { fill: 0.34, percent: "34%", detail: "(68k/200k)", level: "normal" });
});

test("context ゲージの閾値は 70% 超で warn、90% 超で danger", () => {
  const at = (percent: number) => contextGauge({ tokens: null, contextWindow: 200_000, percent });
  assert.equal(at(70)?.level, "normal");
  assert.equal(at(70.1)?.level, "warn");
  assert.equal(at(90)?.level, "warn");
  assert.equal(at(90.1)?.level, "danger");
  assert.equal(at(100)?.level, "danger");
  // fill は百分率そのもの (見える幅は描画側の最小幅で確保する)
  assert.equal(at(1)?.fill, 0.01);
  assert.equal(at(100)?.fill, 1);
  // 分母を超えて報告されてもバーは振り切らない
  assert.equal(at(120)?.fill, 1);
});

test("context ゲージは tokens / percent が無い間も分母だけで出す", () => {
  // compaction 直後 (tokens: null) は不明として出す
  assert.deepEqual(contextGauge({ tokens: null, contextWindow: 200_000, percent: null }), {
    fill: null,
    percent: "?",
    detail: "(?/200k)",
    level: "normal",
  });
  // 応答前 (context 未取得) はモデルの contextWindow を分母に使う
  assert.equal(contextGauge(undefined, 200_000)?.detail, "(?/200k)");
  assert.equal(contextGauge(undefined, 200_000)?.percent, "?");
  assert.equal(contextGauge(undefined, 200_000)?.fill, null);
  // 分母が無ければゲージごと出さない
  assert.equal(contextGauge(undefined, undefined), undefined);
  assert.equal(contextGauge({ tokens: null, contextWindow: 0, percent: null }), undefined);
});

test("percent が無くても tokens から百分率を出す", () => {
  const context: ContextUsage = { tokens: 50_000, contextWindow: 200_000, percent: null };
  assert.equal(contextGauge(context)?.percent, "25%");
  assert.equal(contextGauge(context)?.fill, 0.25);
  assert.equal(contextGauge(context)?.level, "normal");
});

test("compact では絶対値を落とし、百分率だけ残す", () => {
  const context: ContextUsage = { tokens: 68_000, contextWindow: 200_000, percent: 34 };
  assert.equal(contextGauge(context, undefined, true)?.detail, "");
  assert.equal(contextGauge(context, undefined, true)?.percent, "34%");
  assert.equal(contextGauge(context, undefined, false)?.detail, "(68k/200k)");
});
