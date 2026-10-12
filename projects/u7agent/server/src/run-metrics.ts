import { ASK_USER_TOOL_NAME } from "./ask-user-tool";
import type { ToolCall } from "./schema";

type ToolInterval = Pick<ToolCall, "name" | "startedAt" | "endedAt">;

/**
 * 登録 / settle の時刻を使わないのは、片方だけ閉じる経路で値が食い違うため。重なった区間を 1 回だけ
 * 数えるのは、並行した質問で実時間より多く引かないため。
 */
export function askUserWaitTotalMs(tools: Iterable<ToolInterval>, at: number): number {
  const intervals: Array<{ startedAt: number; endedAt: number }> = [];
  for (const tool of tools) {
    if (tool.name !== ASK_USER_TOOL_NAME || tool.startedAt === undefined) continue;
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

/** 負にしないのは、時計のずれで控除が実時間を超えても表示を壊さないため */
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
