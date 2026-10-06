/**
 * 入力欄の直上に出すライブのツール行。実行中のカードだけを走査順で返し、番号はツール履歴の行番号に
 * 合わせる (スキル読み込み・ask_user を外す規則も履歴と同じ)。規則の根拠は docs/frontend.md が正。
 */
import type { RunStatus, ToolCall } from "../types";
import { abbreviatedToolSummary } from "./toolSummary";

export type LiveToolRow = {
  id: string;
  /** ツール履歴に並ぶ通し番号 (スキル読み込み・ask_user を除いた並び) */
  index: number;
  /** `name — args` の 1 行。切り方は履歴の行サマリーと同じ */
  summary: string;
};

export type LiveToolState = {
  rows: LiveToolRow[];
  visible: boolean;
};

/**
 * ライブ表示は「いま動いているツール」だけを出す。run が続いていてもツールが動いていない間は
 * 状態行の文言で足りるため、空の箱を残さない。`queued` は run が動いていない状態なので含めない。
 * 停止・中断で `tool_execution_end` が来なかったカードを回し続けないためでもある (docs/frontend.md)。
 */
export function liveToolState(runTools: Readonly<Record<string, ToolCall>>, runStatus: RunStatus): LiveToolState {
  if (runStatus !== "running") return { rows: [], visible: false };
  const calls = Object.values(runTools).filter((call) => !call.skill && !call.questions?.length);
  const rows = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => !call.done)
    .map(({ call, index }) => ({ id: call.id, index: index + 1, summary: abbreviatedToolSummary(call) }));
  return { rows, visible: rows.length > 0 };
}
