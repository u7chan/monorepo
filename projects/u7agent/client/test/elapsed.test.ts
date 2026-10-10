// 経過時間表示。境界 (秒 → 分 → 時) と負値の丸めを固定値で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed, isElapsedMilestone, isElapsedTier } from "../src/lib/elapsed";

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

// What: 演出を強める節目と、長いランに色を残す境目を、表示と同じ秒の刻みで固定する。
// 秒未満の差で演出が変わると、数字が変わらないのに見た目だけが動く。
test("演出の節目は表示と同じ秒で判定する", () => {
  assert.equal(isElapsedMilestone(9_999), false, "9s の間は節目ではない");
  assert.equal(isElapsedMilestone(10_000), true, "10s で節目");
  assert.equal(isElapsedMilestone(10_999), true, "10s と表示されている間は節目のまま");
  assert.equal(isElapsedMilestone(11_000), false, "11s では戻る");
  assert.equal(isElapsedMilestone(30_000), true);
  assert.equal(isElapsedMilestone(60_000), true);
  assert.equal(isElapsedMilestone(180_000), true);
  assert.equal(isElapsedMilestone(600_000), true);
  assert.equal(isElapsedMilestone(601_000), false);
  assert.equal(isElapsedMilestone(-50), false, "負値でも節目にしない");
});

test("長いランの色は 1 分から残す", () => {
  assert.equal(isElapsedTier(59_999), false);
  assert.equal(isElapsedTier(60_000), true);
});
