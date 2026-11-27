import { askUserWaitTotalMs } from "server/wait-total";
import type { ToolCall } from "../types";

type ToolInterval = Pick<ToolCall, "name" | "startedAt" | "endedAt">;

/** 負にしないのは、時計のずれで控除が実時間を超えても表示を壊さないため */
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

/**
 * 経過時間の表記 (`1m 5s`)。実行中の状態行では必ず固定幅のスロット (`elapsed-slot`) に入れる (文字列の
 * 幅は秒の桁で変わるため、幅が動く場所に置くと状態行が揺れる)。完了したターンの値はそのまま使う。
 */
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
