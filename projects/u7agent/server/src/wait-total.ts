/**
 * 回答待ちの区間を union で合計する計算の正。client (表示) と server (metrics) の両方が使うため、
 * このファイルは import を持たない (`node:sqlite` などが client bundle に入るのを防ぐ)。
 */
export const ASK_USER_TOOL_NAME = "ask_user";
export const REQUEST_NETWORK_ACCESS_TOOL_NAME = "request_network_access";

type ToolInterval = { name: string; startedAt?: number; endedAt?: number };

/**
 * 登録 / settle の時刻を使わないのは、片方だけ閉じる経路で値が食い違うため。重なった区間を 1 回だけ
 * 数えるのは、並行した質問で実時間より多く引かないため。
 */
export function askUserWaitTotalMs(tools: Iterable<ToolInterval>, at: number): number {
  const intervals: Array<{ startedAt: number; endedAt: number }> = [];
  for (const tool of tools) {
    // 承認待ちもユーザーの応答待ちなので、同じ「待ち時間」として数える
    if (
      (tool.name !== ASK_USER_TOOL_NAME && tool.name !== REQUEST_NETWORK_ACCESS_TOOL_NAME) ||
      tool.startedAt === undefined
    ) {
      continue;
    }
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
