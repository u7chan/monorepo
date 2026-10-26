import { formatClock, formatMonthDay } from "./format";

export type ValueAxis = { min: number; max: number; ticks: number[] };

export type TimeTick = { at: number; label: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const VALUE_STEPS = [1, 2, 5, 10, 20, 25, 50];
const HOUR_STEPS = [1, 2, 3, 6, 12];
const DAY_STEPS = [1, 2, 3, 7, 14, 30];

/**
 * 残り％の縦軸。0〜100 固定では数％の変化が数 px に潰れるため、データの範囲へ寄せる。
 * 変化が無い日をノイズで揺らして見せないよう、最小レンジは 10pt にする。
 */
export function buildValueAxis(values: readonly number[]): ValueAxis | null {
  const finite = values.filter((value) => Number.isFinite(value));

  if (finite.length === 0) {
    return null;
  }

  let min = Math.min(...finite);
  let max = Math.max(...finite);
  const center = (min + max) / 2;

  if (max - min < 10) {
    min = center - 5;
    max = center + 5;
  }

  const padding = Math.max(1, (max - min) * 0.08);
  min = clampPercent(min - padding);
  max = clampPercent(max + padding);

  if (max - min < 10) {
    if (max >= 100) {
      min = 90;
    } else {
      max = Math.min(100, min + 10);
    }
  }

  const step = VALUE_STEPS.find((candidate) => (max - min) / candidate <= 4) ?? 50;
  min = Math.max(0, Math.floor(min / step) * step);
  max = Math.min(100, Math.ceil(max / step) * step);

  const ticks: number[] = [];

  for (let value = min; value <= max; value += step) {
    ticks.push(value);
  }

  return ticks.length >= 2 ? { min, max, ticks } : null;
}

/**
 * 横軸の目盛り。1 日以上は日付、1 日未満は時刻にし、右端は常に「今」にする。
 * 目盛りは端数ではなくローカル時刻の区切りへ置く（「18時間前」のような丸め誤差を出さない）。
 */
export function buildTimeTicks(startAt: number, endAt: number): TimeTick[] {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    return [];
  }

  const span = endAt - startAt;
  const ticks: { at: number; label: string }[] = [];

  if (span >= 2 * DAY_MS) {
    const stepDays = DAY_STEPS.find((step) => span / DAY_MS / step <= 5) ?? 30;
    const offset = new Date(startAt);

    offset.setHours(0, 0, 0, 0);

    for (
      let at = new Date(offset.getFullYear(), offset.getMonth(), offset.getDate() + 1);
      at.getTime() < endAt;
      at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + stepDays)
    ) {
      ticks.push({ at: at.getTime(), label: formatMonthDay(at.getTime()) });
    }
  } else {
    const stepHours = HOUR_STEPS.find((step) => span / HOUR_MS / step <= 4) ?? 12;
    const offset = new Date(startAt);

    offset.setMinutes(0, 0, 0);

    for (
      let at = new Date(offset.getFullYear(), offset.getMonth(), offset.getDate(), offset.getHours() + 1);
      at.getTime() < endAt;
      at = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + stepHours)
    ) {
      ticks.push({ at: at.getTime(), label: formatClock(at.getTime()) });
    }
  }

  // 右端の「今」と重なる目盛りは落とす。
  const last = ticks.at(-1);

  if (last && endAt - last.at < span * 0.1) {
    ticks.pop();
  }

  ticks.push({ at: endAt, label: "今" });

  return ticks;
}

/** 使用率が大きく下がった点はリセット。0 付近まで戻るため、通常の増減とは区別できる。 */
export function findResets(points: readonly { at: number; usedPercent: number }[]): number[] {
  const resets: number[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];

    if (previous && current && current.usedPercent - previous.usedPercent <= -5) {
      resets.push(current.at);
    }
  }

  return resets;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
