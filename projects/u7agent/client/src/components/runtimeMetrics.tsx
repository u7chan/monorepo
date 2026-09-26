import { cn } from "../lib/cn";
import { runtimeMetricRatio } from "../lib/runtimeModels";

const GAUGE_TONE = {
  catalog: "text-ink-ghost",
  whitelist: "text-accent-text",
  available: "text-ok",
} as const;

type GaugeTone = keyof typeof GAUGE_TONE;

/**
 * カタログ数を分母にした比率ゲージ。数値だけでは 4/41 と 4/1495 の読み分けができないため、
 * 同じ分母の棒を並べて比べる。分母が 0 のときは塗らない。
 */
export function MetricGauge({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: GaugeTone;
}) {
  // 51/1495 のような小さい比率でも 1px に潰れないよう、0 以外は最小幅を持たせる
  const filled = value > 0 ? Math.max(64 * runtimeMetricRatio(value, total), 3) : 0;
  return (
    <span className="grid gap-1">
      <span className="flex items-baseline gap-1">
        <span className="text-3xs whitespace-nowrap text-ink-faint">{label}</span>
        <span className="font-mono text-2xs text-ink-soft tabular-nums">{value}</span>
      </span>
      {/* 目盛りは無色にする。空のゲージが色付きの帯に見えると「0 件」を成功と読み違える */}
      <svg aria-hidden="true" viewBox="0 0 64 4" className="h-1 w-16 text-line-strong">
        <rect width="64" height="4" rx="2" fill="currentColor" />
        <rect width={filled} height="4" rx="2" className={cn("fill-current", GAUGE_TONE[tone])} />
      </svg>
    </span>
  );
}

/** 3 つのゲージを 1 組にする。全体サマリとプロバイダー行で同じ分母 (カタログ数) を使う */
export function MetricGauges({
  catalog,
  whitelist,
  available,
  availableLabel = "利用可能",
}: {
  catalog: number;
  whitelist: number;
  available: number;
  availableLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <MetricGauge label="カタログ" value={catalog} total={catalog} tone="catalog" />
      <MetricGauge label="whitelist 収載" value={whitelist} total={catalog} tone="whitelist" />
      <MetricGauge label={availableLabel} value={available} total={catalog} tone="available" />
    </div>
  );
}
