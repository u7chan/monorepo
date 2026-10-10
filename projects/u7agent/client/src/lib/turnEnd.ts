/**
 * ターン終端の行 (罫線 + `Complete · 1m 20s`) の文言と整形。値はラン全体 (`run_end.durationMs` と
 * 同じ定義) で、履歴は user item、ライブは `run_end` の値を写す。無いときは行ごと出さない。
 */
import type { RunOutcome, RunStatus } from "../types";
import { formatElapsed } from "./elapsed";

const OUTCOME_LABELS: Record<RunOutcome, string> = {
  completed: "Complete",
  stopped: "Stopped",
  error: "Failed",
};

/** 終了状態の英語。ターン終端のマーカーとして短く読ませるため、日本語 UI の中でここだけ英語にする */
export function turnOutcomeLabel(outcome: RunOutcome): string {
  return OUTCOME_LABELS[outcome];
}

/** `formatElapsed` は秒未満を切り捨てるため、1 秒未満だけ `<1s` にする */
export function formatTurnDuration(ms: number): string {
  return ms < 1000 ? "<1s" : formatElapsed(ms);
}

/** ライブの `run_end.status` (7 値) から終端の結末だけを取り出す。終端以外では行を出さない */
export function runOutcomeOf(status: RunStatus): RunOutcome | undefined {
  return status === "completed" || status === "stopped" || status === "error" ? status : undefined;
}
