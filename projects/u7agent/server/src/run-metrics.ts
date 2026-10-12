/**
 * ランの所要時間から除く待機区間の導出。値の正は BFF 計測 (`ToolCall.startedAt` / `endedAt`) だけで、
 * 質問の登録 / settle の時刻は持たない (2 つの区間を正にすると片方だけ閉じる経路で食い違う)。
 */
import { ASK_USER_TOOL_NAME } from "./ask-user-tool";
import type { ToolCall } from "./schema";

type ToolInterval = Pick<ToolCall, "name" | "startedAt" | "endedAt">;

/**
 * ask_user の実行区間の和 (開いている区間は評価時刻 `at` まで)。並行した待機を二重に引かないよう、
 * 重なった区間は和集合で 1 回だけ数える。
 */
export function askUserWaitTotalMs(tools: Iterable<ToolInterval>, at: number): number {
  const intervals: Array<{ startedAt: number; endedAt: number }> = [];
  for (const tool of tools) {
    // 開始を観測しなかったカードは区間を作らない (従来どおり待機を引かない)
    if (tool.name !== ASK_USER_TOOL_NAME || tool.startedAt === undefined) continue;
    // 終了を観測していない区間は `at` で閉じる。`at` より後に終わった区間も `at` 時点では開いていた
    const endedAt = Math.min(tool.endedAt ?? at, at);
    if (endedAt > tool.startedAt) intervals.push({ startedAt: tool.startedAt, endedAt });
  }
  if (intervals.length === 0) return 0;
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

/** ランの所要時間。キュー待ちと回答待ち (ask_user の実行区間) は含めない */
export function runDurationMs({
  startedAt,
  endedAt,
  tools,
}: {
  startedAt: number;
  endedAt: number;
  tools: Iterable<ToolInterval>;
}): number {
  return Math.max(0, endedAt - startedAt - askUserWaitTotalMs(tools, endedAt));
}
