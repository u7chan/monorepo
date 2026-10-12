/** 実行中インジケータの経過時間の計算と表示。時間の正は BFF 計測 (`ToolCall.startedAt` / `endedAt`) */
import type { ToolCall } from "../types";
import { ASK_USER_TOOL_NAME } from "./askUser";

type ToolInterval = Pick<ToolCall, "name" | "startedAt" | "endedAt">;

/**
 * ask_user の回答待ちの和 (開いている区間は評価時刻 `at` まで)。並行した待機を二重に引かないよう、
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

/** 実行中インジケータの経過時間。回答待ち (ask_user の実行区間) は数えない */
export function runElapsedMs({
  startedAt,
  at,
  tools,
}: {
  startedAt: number;
  at: number;
  tools: Iterable<ToolInterval>;
}): number {
  return Math.max(0, at - startedAt - askUserWaitTotalMs(tools, at));
}

/** 実行中インジケータの経過時間 (1 秒ごとに更新する表示なので秒未満は出さない。locale 非依存) */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** 演出を出す拍の長さ。桁は毎秒変わるが、演出はこの間隔でしか出さない */
const BEAT_MS = 10_000;

/** 経過時間の拍の番号 (0 始まり)。この値が変わった瞬間だけ演出を先頭から流す */
export function elapsedBeatIndex(ms: number): number {
  return Math.floor(Math.max(0, ms) / BEAT_MS);
}

/** 経過時間に色を残し始める長さ */
const TIER_MS = 60_000;

/** 長いランを一目で見分けられるよう、経過時間に色を残すか (停止の判定には使わない) */
export function isElapsedTier(ms: number): boolean {
  return ms >= TIER_MS;
}
