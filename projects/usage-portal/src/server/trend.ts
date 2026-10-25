import type { UsageWindow } from "./providers/types";

export type SamplePoint = { at: number; usedPercent: number };

export type Trend = { windowId: string; points: SamplePoint[] };

/** 5 分間隔の sample を 30 分の bucket に丸めると、24 時間がちょうど 48 点になる。 */
export const TREND_BUCKET_MS = 30 * 60 * 1000;
export const TREND_MAX_POINTS = 48;

/**
 * 推移を描く枠を 1 つ選ぶ。使用率が最も高い枠を主役にし、同値なら短い枠を選ぶ
 * （同じ数値なら、より早くリセットされる枠の方が行動の判断に効く）。
 */
export function selectTrendWindow(windows: UsageWindow[]): UsageWindow | null {
  let selected: UsageWindow | null = null;

  for (const window of windows) {
    if (
      selected === null ||
      window.usedPercent > selected.usedPercent ||
      (window.usedPercent === selected.usedPercent && shorter(window, selected))
    ) {
      selected = window;
    }
  }

  return selected;
}

/** sample を bucket ごとに平均し、古い側から最大 48 点を返す。2 点未満なら推移として描かない。 */
export function buildTrend(windowId: string, samples: SamplePoint[]): Trend | null {
  const buckets = new Map<number, { sum: number; count: number }>();

  for (const sample of samples) {
    if (!Number.isFinite(sample.at) || !Number.isFinite(sample.usedPercent)) {
      continue;
    }

    const bucket = Math.floor(sample.at / TREND_BUCKET_MS) * TREND_BUCKET_MS;
    const current = buckets.get(bucket) ?? { sum: 0, count: 0 };

    buckets.set(bucket, { sum: current.sum + sample.usedPercent, count: current.count + 1 });
  }

  const points = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-TREND_MAX_POINTS)
    .map(([at, bucket]) => ({ at, usedPercent: bucket.sum / bucket.count }));

  return points.length < 2 ? null : { windowId, points };
}

function shorter(candidate: UsageWindow, current: UsageWindow): boolean {
  return (candidate.durationSeconds ?? Number.MAX_SAFE_INTEGER) < (current.durationSeconds ?? Number.MAX_SAFE_INTEGER);
}
