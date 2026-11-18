/**
 * 応答時間 / TTFT / tok/s の計算。live と復元で計算式を別々に書くと片方だけ直るため、規則はここだけが持つ。
 */
import type { MessageMetrics } from "./schema";

/**
 * 応答時間 / TTFT / tok/s の計算の入口。live と復元で計算式を別々に書くと片方だけ直るため、
 * 規則はここだけが持つ。
 */
export function computeMessageMetrics({
  durationMs,
  ttftMs,
  outputTokens,
}: {
  durationMs: number;
  /** 最初の delta までの時間。最初の delta の時刻が残らない経路 (復元) では渡さない */
  ttftMs?: number;
  outputTokens: number | undefined;
}): MessageMetrics | undefined {
  if (durationMs < 0) return undefined;
  const metrics: MessageMetrics = { durationMs };
  // 負の TTFT は時計のずれでしか作れないため、未記録として全体の duration で割る
  if (ttftMs !== undefined && ttftMs >= 0) metrics.ttftMs = ttftMs;
  const streamSpan = metrics.ttftMs === undefined ? durationMs : durationMs - metrics.ttftMs;
  const span = streamSpan > 0 ? streamSpan : durationMs;
  if (span > 0 && outputTokens !== undefined && outputTokens > 0) {
    metrics.tokensPerSecond = (outputTokens * 1000) / span;
  }
  return metrics;
}
