// ターンの結末 (応答のメタ行に足す `Done · 1m 20s`) の文言・整形と、ライブの run_end.status (7 値)
// から終端の結末を取り出す純関数のテスト。
import assert from "node:assert/strict";
import test from "node:test";
import { formatTurnDuration, runOutcomeOf, turnEndText, turnOutcomeLabel } from "../src/lib/turnEnd";
import type { RunStatus } from "../src/types";

test("終了状態は 3 値とも過去分詞の英語になる", () => {
  assert.equal(turnOutcomeLabel("completed"), "Done");
  assert.equal(turnOutcomeLabel("stopped"), "Stopped");
  assert.equal(turnOutcomeLabel("error"), "Failed");
});

test("所要時間は状態行と同じ formatElapsed の表記で、1 秒未満だけ <1s になる", () => {
  // formatElapsed は秒未満を切り捨てるため、0s ではなく <1s にする
  assert.equal(formatTurnDuration(0), "<1s");
  assert.equal(formatTurnDuration(999), "<1s");
  assert.equal(formatTurnDuration(1000), "1s");
  assert.equal(formatTurnDuration(59_999), "59s");
  assert.equal(formatTurnDuration(80_000), "1m 20s");
  assert.equal(formatTurnDuration(3_600_000), "1h 0m");
});

test("メタ行のセグメントは結末と時間を 1 つの量にする", () => {
  assert.equal(turnEndText({ outcome: "completed", durationMs: 80_000 }), "Done · 1m 20s");
  assert.equal(turnEndText({ outcome: "stopped", durationMs: 1000 }), "Stopped · 1s");
  assert.equal(turnEndText({ outcome: "error", durationMs: 400 }), "Failed · <1s");
});

test("run_end.status は終端の 3 値だけを結末として通す", () => {
  assert.equal(runOutcomeOf("completed"), "completed");
  assert.equal(runOutcomeOf("stopped"), "stopped");
  assert.equal(runOutcomeOf("error"), "error");
  // 終端以外では値を付けない (実行中 / キュー待ち / 圧縮中 / 待機)
  const nonTerminal: RunStatus[] = ["idle", "running", "queued", "compacting"];
  assert.deepEqual(
    nonTerminal.map((status) => runOutcomeOf(status)),
    [undefined, undefined, undefined, undefined],
  );
});
