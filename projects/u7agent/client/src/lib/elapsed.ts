/** 実行中インジケータの経過時間 (1 秒ごとに更新する表示なので秒未満は出さない。locale 非依存) */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** 毎秒の演出を強める秒。表示の書式 (formatElapsed) とは独立に、演出だけを決める */
const MILESTONE_SECONDS = [10, 30, 60, 180, 300, 600];

/** 経過時間の演出を強める節目か。表示と同じ秒で判定する (30.9s は 30s の節目) */
export function isElapsedMilestone(ms: number): boolean {
  return MILESTONE_SECONDS.includes(Math.floor(Math.max(0, ms) / 1000));
}

/** 経過時間に色を残し始める長さ */
const TIER_MS = 60_000;

/** 長いランを一目で見分けられるよう、経過時間に色を残すか (停止の判定には使わない) */
export function isElapsedTier(ms: number): boolean {
  return ms >= TIER_MS;
}
