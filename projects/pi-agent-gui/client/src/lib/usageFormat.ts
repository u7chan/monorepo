/**
 * 応答メタ情報の整形。locale に依存させない (数値と単位だけの表記にし、桁区切りは使わない)。
 * 0 は「プロバイダが報告していない」と同じ意味になり得るため、表示側では値を出さない。
 */
import type { ContextUsage, MessageMetrics, Usage } from "../types";

/** pi TUI footer と同じ刻み (999 / 1.0k / 12k / 1.2M) */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatTokensPerSecond(value: number): string {
  // 100 を超えると小数第 1 位は読み取りの邪魔にしかならない
  const rounded = value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} tok/s`;
}

/** 単位が小さくなるほど桁を増やし、丸めで 0 に見えないようにする */
export function formatCost(total: number): string {
  if (total >= 1) return `$${total.toFixed(2)}`;
  if (total >= 0.01) return `$${total.toFixed(3)}`;
  return `$${total.toFixed(4)}`;
}

/** バブル下の常時表示。compact (portrait / landscape) は応答時間と tok/s だけに絞る */
export function messageMetaLine(
  usage: Usage | undefined,
  metrics: MessageMetrics | undefined,
  compact: boolean,
): string {
  const parts: string[] = [];
  if (metrics) {
    parts.push(formatDurationMs(metrics.durationMs));
    if (metrics.tokensPerSecond !== undefined) {
      parts.push(formatTokensPerSecond(metrics.tokensPerSecond));
    }
    if (compact) return parts.join(" · ");
  }
  const tokens: string[] = [];
  if (usage) {
    if (usage.input > 0) tokens.push(`↑${formatTokens(usage.input)}`);
    if (usage.output > 0) tokens.push(`↓${formatTokens(usage.output)}`);
  }
  // ↑ と ↓ は 1 つの量 (入出力トークン) なので、区切りを他と同じ " · " にはしない
  if (tokens.length > 0) parts.push(tokens.join(" "));
  return parts.join(" · ");
}

/** ホバー (title) の詳細。報告が無い項目は出さない */
export function messageMetaTitle(
  usage: Usage | undefined,
  metrics: MessageMetrics | undefined,
): string | undefined {
  const details: string[] = [];
  if (metrics?.ttftMs !== undefined) details.push(`TTFT ${formatDurationMs(metrics.ttftMs)}`);
  if (usage) {
    const cache: string[] = [];
    if (usage.cacheRead > 0) cache.push(`R ${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite > 0) cache.push(`W ${formatTokens(usage.cacheWrite)}`);
    if (cache.length > 0) details.push(`cache ${cache.join(" ")}`);
    if ((usage.reasoning ?? 0) > 0) details.push(`thinking ${formatTokens(usage.reasoning as number)} tok`);
    if (usage.cost.total > 0) details.push(formatCost(usage.cost.total));
  }
  return details.length > 0 ? details.join(" / ") : undefined;
}

export type ContextGaugeLevel = "normal" | "warn" | "danger";

export type ContextGauge = {
  bar: string;
  percent: string;
  detail: string;
  level: ContextGaugeLevel;
};

const GAUGE_SEGMENTS = 5;
const FILLED = "▓";
const EMPTY = "░";
// pi TUI footer と同じ閾値 (70% 超で warn、90% 超で danger)
const WARN_PERCENT = 70;
const DANGER_PERCENT = 90;

/**
 * Composer の context ゲージ。SDK が tokens / percent を持たない間も分母 (モデルの
 * contextWindow) だけで表示でき、compaction 直後 (tokens: null) は不明として出す。
 */
export function contextGauge(context?: ContextUsage, fallbackWindow?: number): ContextGauge | undefined {
  const contextWindow = context?.contextWindow ?? fallbackWindow;
  if (!contextWindow || contextWindow <= 0) return undefined;
  const percent = context?.percent ?? (context?.tokens != null ? (context.tokens / contextWindow) * 100 : undefined);
  const filled = percent === undefined || percent <= 0
    ? 0
    : Math.min(GAUGE_SEGMENTS, Math.max(1, Math.round((percent / 100) * GAUGE_SEGMENTS)));
  const tokens = context?.tokens != null ? formatTokens(context.tokens) : "?";
  return {
    bar: FILLED.repeat(filled) + EMPTY.repeat(GAUGE_SEGMENTS - filled),
    percent: percent === undefined ? "?" : `${Math.round(percent)}%`,
    detail: `(${tokens}/${formatTokens(contextWindow)})`,
    level:
      percent !== undefined && percent > DANGER_PERCENT
        ? "danger"
        : percent !== undefined && percent > WARN_PERCENT
          ? "warn"
          : "normal",
  };
}
