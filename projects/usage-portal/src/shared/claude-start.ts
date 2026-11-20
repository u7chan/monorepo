/**
 * Claude の 5 時間窓を開始する予約の、画面とサーバーで共有する入力規則と時刻の計算。
 * 窓は短くできないので、1 日の余り（24 − 5 × 回数 時間）を「空き」として 1 か所に置き、
 * 空きのあとの最初の開始から 5 時間おきに回数ぶん開始する。
 */

export const CLAUDE_START_WINDOW_MINUTES = 300;
export const CLAUDE_START_MAX_COUNT = 4;
export const CLAUDE_START_MODELS = ["haiku", "sonnet", "opus"] as const;
export const CLAUDE_START_EFFORTS = ["low", "medium", "high"] as const;
/** 3 回続けて失敗したら自動の開始を止める。見送りは数えない。 */
export const CLAUDE_START_MAX_FAILURES = 3;

const DAY_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
/** 空きを寄せる深夜の範囲（0:00〜7:00）。 */
const NIGHT_END_MINUTE = 7 * 60;

export type ClaudeStartModel = (typeof CLAUDE_START_MODELS)[number];
export type ClaudeStartEffort = (typeof CLAUDE_START_EFFORTS)[number];

export type ClaudeStartSettings = {
  /** 必ずリセットさせる時刻。予約したタイムゾーンでの 0:00 からの分。 */
  anchorMinute: number;
  /** 1 日に開始する回数。 */
  count: number;
  /** 必ずリセットさせる時刻を、何番目の窓の終わりにするか（1 始まり）。空きの位置がこれで決まる。 */
  option: number;
  /** 曜日（0 = 日曜）。空きのあと、最初の開始の日で数える。 */
  days: number[];
  timeZone: string;
  model: ClaudeStartModel;
  effort: ClaudeStartEffort;
};

/** 1 日ぶんの開始。分はその日の 0:00 から数え、1440 を超えた値は翌日を表す。 */
export type ClaudeStartCycle = {
  option: number;
  starts: number[];
  gapFrom: number;
  gapTo: number;
};

export function startCycle(anchorMinute: number, count: number, option: number): ClaudeStartCycle {
  const first = mod(anchorMinute - CLAUDE_START_WINDOW_MINUTES * option, DAY_MINUTES);
  const starts = Array.from({ length: count }, (_, index) => first + CLAUDE_START_WINDOW_MINUTES * index);

  return { option, starts, gapFrom: first + CLAUDE_START_WINDOW_MINUTES * count, gapTo: first + DAY_MINUTES };
}

/** 空きの候補。必ずリセットさせる時刻を 1〜回数 番目の窓の終わりに置いた分だけある。 */
export function startCycleOptions(anchorMinute: number, count: number): ClaudeStartCycle[] {
  return Array.from({ length: count }, (_, index) => startCycle(anchorMinute, count, index + 1));
}

/** 空きが深夜と最も長く重なる候補。同じ長さなら番号の小さい方。 */
export function recommendedStartOption(anchorMinute: number, count: number): number {
  let best = 1;
  let bestOverlap = -1;

  for (const cycle of startCycleOptions(anchorMinute, count)) {
    const overlap = nightOverlap(cycle);

    if (overlap > bestOverlap) {
      best = cycle.option;
      bestOverlap = overlap;
    }
  }

  return best;
}

function nightOverlap(cycle: ClaudeStartCycle): number {
  let total = 0;

  // 空きは最長 20 時間なので、日をまたぐ 2 区間の重なりを足せば足りる。
  for (const dayStart of [0, DAY_MINUTES]) {
    const from = Math.max(cycle.gapFrom, dayStart);
    const to = Math.min(cycle.gapTo, dayStart + NIGHT_END_MINUTE);

    total += Math.max(0, to - from);
  }

  return total;
}

/** 画面の入力を検証して正規化する。1 つでも外れたら null。 */
export function readClaudeStartSettings(value: unknown): ClaudeStartSettings | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const { anchorMinute, count, option, days, timeZone, model, effort } = record;

  if (!isIntegerBetween(anchorMinute, 0, DAY_MINUTES - 1) || !isIntegerBetween(count, 1, CLAUDE_START_MAX_COUNT)) {
    return null;
  }

  if (!isIntegerBetween(option, 1, count)) {
    return null;
  }

  if (!Array.isArray(days) || days.length === 0 || !days.every((day) => isIntegerBetween(day, 0, 6))) {
    return null;
  }

  if (typeof timeZone !== "string" || !isTimeZone(timeZone)) {
    return null;
  }

  if (!isOneOf(model, CLAUDE_START_MODELS) || !isOneOf(effort, CLAUDE_START_EFFORTS)) {
    return null;
  }

  return {
    anchorMinute,
    count,
    option,
    days: [...new Set(days as number[])].sort((a, b) => a - b),
    timeZone,
    model,
    effort,
  };
}

/**
 * `[from, to]` に入る開始の時刻（epoch ms）を古い順に返す。
 * 開始の曜日は、その日の最初の開始（空きのあと）の日で決める。
 */
export function startSlots(settings: ClaudeStartSettings, from: number, to: number): number[] {
  const cycle = startCycle(settings.anchorMinute, settings.count, settings.option);
  // 1 日の開始は最大で翌日の途中まで続くので、前日の分から数える。
  const first = zonedDate(from - DAY_MINUTES * MINUTE_MS, settings.timeZone);
  const last = zonedDate(to, settings.timeZone);

  if (first === null || last === null) {
    return [];
  }

  const slots: number[] = [];

  for (let date = first; compareDate(date, last) <= 0; date = nextDate(date)) {
    if (!settings.days.includes(weekday(date))) {
      continue;
    }

    for (const minute of cycle.starts) {
      const at = zonedTimeToEpoch(date, minute, settings.timeZone);

      if (at !== null && at >= from && at <= to) {
        slots.push(at);
      }
    }
  }

  return slots.sort((a, b) => a - b);
}

/** `after` より後の最初の開始。8 日先までに無ければ null（曜日を 1 つも選んでいない場合は検証で弾く）。 */
export function nextStartSlot(settings: ClaudeStartSettings, after: number): number | null {
  return startSlots(settings, after + 1, after + 8 * DAY_MINUTES * MINUTE_MS)[0] ?? null;
}

/** `at` 以前で、`lookbackMs` 以内の最後の開始。 */
export function latestStartSlot(settings: ClaudeStartSettings, at: number, lookbackMs: number): number | null {
  return startSlots(settings, at - lookbackMs, at).at(-1) ?? null;
}

export function formatMinuteOfDay(minute: number): string {
  const value = mod(minute, DAY_MINUTES);

  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

type CalendarDate = { year: number; month: number; day: number };

function zonedDate(instant: number, timeZone: string): CalendarDate | null {
  const parts = zonedParts(instant, timeZone);

  return parts === null ? null : { year: parts.year, month: parts.month, day: parts.day };
}

function nextDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));

  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function compareDate(a: CalendarDate, b: CalendarDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

function weekday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** 壁時計の時刻を epoch へ。オフセットは 2 回引き直し、夏時間の切り替え前後でもずれを残さない。 */
function zonedTimeToEpoch(date: CalendarDate, minute: number, timeZone: string): number | null {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minute);
  const firstOffset = timeZoneOffset(wall, timeZone);

  if (firstOffset === null) {
    return null;
  }

  const secondOffset = timeZoneOffset(wall - firstOffset, timeZone);

  return secondOffset === null ? null : wall - secondOffset;
}

function timeZoneOffset(instant: number, timeZone: string): number | null {
  const parts = zonedParts(instant, timeZone);

  if (parts === null) {
    return null;
  }

  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

  return wall - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

type ZonedParts = CalendarDate & { hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(instant: number, timeZone: string): ZonedParts | null {
  let formatter = formatters.get(timeZone);

  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
    } catch {
      return null;
    }

    formatters.set(timeZone, formatter);
  }

  const values: Record<string, number> = {};

  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  const { year, month, day, hour, minute } = values;

  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) {
    return null;
  }

  return { year, month, day, hour, minute };
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });

    return value !== "";
  } catch {
    return false;
  }
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
