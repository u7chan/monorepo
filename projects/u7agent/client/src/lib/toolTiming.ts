/**
 * ツール実行時間の導出。値の正は BFF 計測 (`ToolCall.startedAt` / `endedAt`) で、SDK も履歴も
 * 実行時刻を持たない。片方でも欠けたカードは推測で合成せず、実行時間を出さない。
 */
import type { ToolCall } from "../types";

export type ToolTiming = { startedAt: number; endedAt: number };

type ToolInterval = Pick<ToolCall, "startedAt" | "endedAt">;

/** 閉じた区間のときだけ返す (欠けた値・逆転した値を表示の入力にしない) */
function closedInterval(call: ToolInterval): ToolTiming | undefined {
  const { startedAt, endedAt } = call;
  if (startedAt === undefined || endedAt === undefined) return undefined;
  if (!(endedAt >= startedAt)) return undefined;
  return { startedAt, endedAt };
}

export function toolDurationMs(call: ToolInterval): number | undefined {
  const interval = closedInterval(call);
  return interval === undefined ? undefined : interval.endedAt - interval.startedAt;
}

/**
 * カード列の合計実行時間。ツールは並列でも走るため、重なった区間を 1 回だけ数える
 * (単純な和は並列実行で実経過より大きくなる)。1 枚でも区間が閉じていなければ、過小な合計を
 * 出さないよう undefined を返す (停止・中止で `tool_execution_end` が来なかったカードがある)。
 */
export function toolTimeTotalMs(cards: readonly ToolInterval[]): number | undefined {
  const intervals: ToolTiming[] = [];
  for (const card of cards) {
    const interval = closedInterval(card);
    if (interval === undefined) return undefined;
    intervals.push(interval);
  }
  if (intervals.length === 0) return undefined;
  intervals.sort((a, b) => a.startedAt - b.startedAt);
  const [first, ...rest] = intervals;
  let total = 0;
  let start = first.startedAt;
  let end = first.endedAt;
  for (const interval of rest) {
    if (interval.startedAt > end) {
      total += end - start;
      start = interval.startedAt;
      end = interval.endedAt;
      continue;
    }
    if (interval.endedAt > end) end = interval.endedAt;
  }
  return total + (end - start);
}
