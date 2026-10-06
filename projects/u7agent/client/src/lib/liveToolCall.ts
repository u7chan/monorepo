/**
 * 入力欄の直上に出すライブのツール行。「いま動いているツール」だけを走査順で返し、番号は
 * ツール履歴の行番号に合わせる (スキル読み込み・ask_user を外す規則も履歴と同じ)。
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
 * 出すのは「いま動いているツール」だけにする。run が続いていてもツールが動いていない間
 * (考え中 / 応答の生成中) は状態行の文言で足りるため、空の箱を残さない。
 * 実行の状態を条件に入れるのは、停止・中断で `tool_execution_end` が来なかったカードが
 * `done: false` のまま `runTools` に残っても、回り続ける行を出さないため。
 */
export function liveToolState(runTools: Readonly<Record<string, ToolCall>>, runStatus: RunStatus): LiveToolState {
  if (runStatus !== "running" && runStatus !== "queued") return { rows: [], visible: false };
  const calls = Object.values(runTools).filter((call) => !call.skill && !call.questions?.length);
  const rows = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => !call.done)
    .map(({ call, index }) => ({ id: call.id, index: index + 1, summary: abbreviatedToolSummary(call) }));
  return { rows, visible: rows.length > 0 };
}
