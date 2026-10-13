/**
 * ターンの結末 (応答のメタ行に足す `Done · 1m 20s`) の型と文言。値はラン全体 (`run_end.durationMs` と
 * 同じ定義) で、履歴はそのターン最後の本文あり応答 item の `turnEnd`、ライブは `run_end` の値を写した
 * user バブル (`runDurationMs` / `runOutcome`) が持つ。無いときはセグメントごと出さない。
 */
import type { RunOutcome, RunStatus } from "../types";
import { formatElapsed } from "./elapsed";

/**
 * 値の出どころは履歴 item の `turnEnd` と user バブル (`runDurationMs` / `runOutcome`)、
 * 表示先はそのターンの応答のメタ行
 */
export type TurnEnd = {
  outcome: RunOutcome;
  durationMs: number;
};

const OUTCOME_LABELS: Record<RunOutcome, string> = {
  completed: "Done",
  stopped: "Stopped",
  error: "Failed",
};

/** 結末の英語。メタ行の 1 セグメントとして短く読ませるため、日本語 UI の中でここだけ英語にする */
export function turnOutcomeLabel(outcome: RunOutcome): string {
  return OUTCOME_LABELS[outcome];
}

/** `formatElapsed` は秒未満を切り捨てるため、1 秒未満だけ `<1s` にする */
export function formatTurnDuration(ms: number): string {
  return ms < 1000 ? "<1s" : formatElapsed(ms);
}

/** メタ行の 1 セグメント。行の文法 (量を ` · ` で区切る) に合わせ、結末と時間を 1 つの量にする */
export function turnEndText(turnEnd: TurnEnd): string {
  return `${turnOutcomeLabel(turnEnd.outcome)} · ${formatTurnDuration(turnEnd.durationMs)}`;
}

/** ライブの `run_end.status` (7 値) から終端の結末だけを取り出す。終端以外では値を付けない */
export function runOutcomeOf(status: RunStatus): RunOutcome | undefined {
  return status === "completed" || status === "stopped" || status === "error" ? status : undefined;
}
