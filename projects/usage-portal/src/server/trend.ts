import type { UsageWindow } from "./providers/types";

export type SamplePoint = { at: number; usedPercent: number };

export type Trend = {
  windowId: string;
  spanMs: number;
  points: SamplePoint[];
  /** 間引き前の sample で検出したリセット時刻。点列からは消えるリセットを残すために別で持つ。 */
  resets: number[];
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 1 本のグラフに載せる点の上限。bucket を広げてこれを超えないようにする。 */
export const TREND_MAX_POINTS = 48;
/** sampler は 5 分間隔。それより短い bucket に分けても点は増えない。 */
const MIN_BUCKET_MS = 5 * MINUTE_MS;
/** sample の保持期間（30 日）より長くさかのぼっても描くものは無い。 */
export const MAX_TREND_SPAN_MS = 30 * DAY_MS;

/**
 * OpenCode Go は期間を返さないので、窓の id から横軸の長さを決める。
 * 5 時間 / 7 日 / 30 日は OpenCode Go の利用枠の定義（月次に対して 20% / 50% / 100%）に合わせる。
 */
const ID_SPANS_MS: Record<string, number> = {
  rolling: 5 * HOUR_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

/**
 * 推移の横軸に使う期間。Codex は上流の `limit_window_seconds` をそのまま使い、
 * OpenCode Go は返らないので窓の id から引く。id が既知でない場合は 24 時間にする。
 * ラベルは期間欠損を rolling に寄せた結果でもあるため、期間の根拠にしない。
 */
export function trendSpanMs(window: UsageWindow): number {
  const seconds = window.durationSeconds;
  const span =
    seconds !== null && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : (ID_SPANS_MS[window.id] ?? 24 * HOUR_MS);

  return Math.min(span, MAX_TREND_SPAN_MS);
}

/**
 * sample を 48 点以下へ間引く。bucket 内では新しい sample を残す。
 * 平均にするとリセットをまたいだ bucket が実在しない値になるため、代表点を選ぶだけにする。
 * bucket の幅は、履歴がまだ短いうちはその範囲に合わせる（7 日分たまるまで 1 本も描けない、を避ける）。
 */
export function buildTrend(windowId: string, spanMs: number, samples: SamplePoint[]): Trend | null {
  const ordered = samples
    .filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.usedPercent))
    .sort((a, b) => a.at - b.at);
  const first = ordered[0];
  const last = ordered.at(-1);

  if (!first || !last) {
    return null;
  }

  const coverage = Math.min(spanMs, last.at - first.at);
  const bucketMs = Math.max(MIN_BUCKET_MS, Math.ceil(coverage / TREND_MAX_POINTS));
  const buckets = new Map<number, SamplePoint>();

  for (const sample of ordered) {
    const bucket = Math.floor(sample.at / bucketMs) * bucketMs;
    const current = buckets.get(bucket);

    if (!current || sample.at > current.at) {
      buckets.set(bucket, sample);
    }
  }

  const points = [...buckets.values()].sort((a, b) => a.at - b.at).slice(-TREND_MAX_POINTS);

  return points.length < 2 ? null : { windowId, spanMs, points, resets: findResets(ordered) };
}

/**
 * リセットは間引き前の sample で検出する。bucket の代表点だけを見ると、
 * 同じ bucket 内で使用率が 20 → 0 → 20% と戻ったリセットが代表点から消えるため。
 */
function findResets(samples: readonly SamplePoint[]): number[] {
  const resets: number[] = [];

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];

    if (previous && current && current.usedPercent - previous.usedPercent <= -5) {
      resets.push(current.at);
    }
  }

  return resets;
}
