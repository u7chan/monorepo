// 経過時間表示。境界 (秒 → 分 → 時) と負値の丸めを固定値で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { elapsedBeatIndex, formatElapsed, isElapsedTier } from "../src/lib/elapsed";

test("formatElapsed は秒・分・時で刻む", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(1000), "1s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(61_400), "1m 1s");
  assert.equal(formatElapsed(3_599_000), "59m 59s");
  assert.equal(formatElapsed(3_600_000), "1h 0m");
  assert.equal(formatElapsed(7_860_000), "2h 11m");
  assert.equal(formatElapsed(-50), "0s");
});

// What: 演出の拍の境界を 10 秒の刻みで固定する。桁は毎秒変わっても、演出はこの境界でしか出さない。
test("演出の拍は 10 秒ごとに変わる", () => {
  assert.equal(elapsedBeatIndex(0), 0);
  assert.equal(elapsedBeatIndex(9_999), 0, "10s の手前までは同じ拍");
  assert.equal(elapsedBeatIndex(10_000), 1, "10s で拍が変わる");
  assert.equal(elapsedBeatIndex(10_999), 1, "10s と表示されている間は同じ拍");
  assert.equal(elapsedBeatIndex(19_999), 1);
  assert.equal(elapsedBeatIndex(20_000), 2);
  assert.equal(elapsedBeatIndex(600_000), 60);
  assert.equal(elapsedBeatIndex(-50), 0, "負値でも拍を戻さない");
});

test("長いランの色は 1 分から残す", () => {
  assert.equal(isElapsedTier(59_999), false);
  assert.equal(isElapsedTier(60_000), true);
});
