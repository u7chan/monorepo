// 経過時間表示。境界 (秒 → 分 → 時) と負値の丸めを固定値で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "../src/lib/elapsed";

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
