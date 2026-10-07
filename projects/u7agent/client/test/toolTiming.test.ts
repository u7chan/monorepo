// ツール実行時間の導出 (1 件の所要時間と、カード列の合計) の検証。
import assert from "node:assert/strict";
import test from "node:test";
import { toolDurationMs, toolTimeTotalMs } from "../src/lib/toolTiming";

test("toolDurationMs は閉じた区間のときだけ実行時間を返す", () => {
  assert.equal(toolDurationMs({ startedAt: 1_000, endedAt: 1_250 }), 250);
  assert.equal(toolDurationMs({ startedAt: 1_000, endedAt: 1_000 }), 0, "0ms も実行時間として出す");
  assert.equal(toolDurationMs({}), undefined, "開始と終了の両方が無い");
  assert.equal(toolDurationMs({ startedAt: 1_000 }), undefined, "開始だけ (停止で終了が来なかった)");
  assert.equal(toolDurationMs({ endedAt: 1_250 }), undefined, "終了だけ");
  assert.equal(toolDurationMs({ startedAt: 1_250, endedAt: 1_000 }), undefined, "逆転した区間");
});

test("toolTimeTotalMs は区間の重なりを 1 回だけ数える", () => {
  assert.equal(toolTimeTotalMs([]), undefined, "カードが無ければ合計も出さない");
  assert.equal(
    toolTimeTotalMs([
      { startedAt: 0, endedAt: 1_000 },
      { startedAt: 2_000, endedAt: 3_000 },
    ]),
    2_000,
    "重ならない分は単純な和",
  );
  assert.equal(
    toolTimeTotalMs([
      { startedAt: 0, endedAt: 1_000 },
      { startedAt: 500, endedAt: 1_500 },
    ]),
    1_500,
    "並列で重なった分を二重に数えない",
  );
  assert.equal(
    toolTimeTotalMs([
      { startedAt: 500, endedAt: 1_500 },
      { startedAt: 0, endedAt: 1_000 },
    ]),
    1_500,
    "入力順に依存しない",
  );
  assert.equal(
    toolTimeTotalMs([
      { startedAt: 0, endedAt: 1_000 },
      { startedAt: 0, endedAt: 1_000 },
    ]),
    1_000,
    "同時に走った 2 件は経過時間 1 つ分",
  );
  assert.equal(
    toolTimeTotalMs([
      { startedAt: 0, endedAt: 1_000 },
      { startedAt: 1_000, endedAt: 2_000 },
    ]),
    2_000,
    "接した区間は 1 本に繋げる",
  );
});

test("toolTimeTotalMs は区間が閉じないカードが 1 枚でもあれば出さない", () => {
  assert.equal(toolTimeTotalMs([{ startedAt: 0, endedAt: 1_000 }, { startedAt: 2_000 }]), undefined, "開始だけ");
  assert.equal(toolTimeTotalMs([{ startedAt: 0, endedAt: 1_000 }, {}]), undefined, "計測前");
  assert.equal(
    toolTimeTotalMs([
      { startedAt: 0, endedAt: 1_000 },
      { startedAt: 2_000, endedAt: 1_000 },
    ]),
    undefined,
    "逆転した区間",
  );
});
