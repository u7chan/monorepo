/**
 * メッセージ / ファイル行の時刻の表示整形。表記は日本語 UI に合わせて ja-JP 固定にする
 * (ブラウザの locale 設定で表記が変わらないようにするため)。
 */

const LOCALE = "ja-JP";

type TimeFormat = "time" | "dayMonth" | "yearMonthDay" | "yearMonthDayWeekday" | "year";

const FORMAT_OPTIONS: Record<TimeFormat, Intl.DateTimeFormatOptions> = {
  // 環境の時計設定 (12/24 時間) に左右されないよう h23 を明示する
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  dayMonth: { month: "numeric", day: "numeric" },
  yearMonthDay: { year: "numeric", month: "numeric", day: "numeric" },
  // ja-JP の weekday: "short" は「2026/9/5(土)」になる
  yearMonthDayWeekday: { year: "numeric", month: "numeric", day: "numeric", weekday: "short" },
  year: { year: "numeric" },
};

// Intl.DateTimeFormat の生成は重い。メッセージごと・再描画ごとに作らないようキー付きでキャッシュする。
const formatters = new Map<string, Intl.DateTimeFormat>();

function format(kind: TimeFormat, at: number, timeZone?: string): string {
  const key = `${kind}|${timeZone ?? ""}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    // timeZone は実行環境の既定と、テストで固定する TZ の両方を同じ関数で扱いたいので引数で受ける
    formatter = new Intl.DateTimeFormat(LOCALE, { ...FORMAT_OPTIONS[kind], timeZone });
    formatters.set(key, formatter);
  }
  return formatter.format(at);
}

export type MessageTimeOptions = {
  timeZone?: string;
  now?: number;
};

/** 今日 / 今年 / それ以前。日付をどこまで出し、時刻を添えるかを決める粒度 */
type TimeScope = "today" | "thisYear" | "older";

const SCOPE_FORMATS: Record<TimeScope, TimeFormat> = {
  today: "time",
  thisYear: "dayMonth",
  older: "yearMonthDay",
};

function timeScope(at: number, now: number, timeZone?: string): TimeScope {
  if (format("yearMonthDay", at, timeZone) === format("yearMonthDay", now, timeZone)) return "today";
  if (format("year", at, timeZone) === format("year", now, timeZone)) return "thisYear";
  return "older";
}

/** チャットの吹き出しとセッション行の時刻。日付だけを出す粒度では時刻を落とす */
export function messageTimeLabel(at: number, options: MessageTimeOptions = {}): string {
  const { timeZone, now = Date.now() } = options;
  return format(SCOPE_FORMATS[timeScope(at, now, timeZone)], at, timeZone);
}

/**
 * ファイル行の更新時刻。メッセージと違い、日付だけでは「新しい順にいつ更新されたか」を
 * 読み取れないため、月日を出す場合は時刻を添える (今日は時刻だけで足りる)。
 */
export function fileTimeLabel(at: number, options: MessageTimeOptions = {}): string {
  const { timeZone, now = Date.now() } = options;
  const scope = timeScope(at, now, timeZone);
  const date = format(SCOPE_FORMATS[scope], at, timeZone);
  return scope === "today" ? date : `${date} ${format("time", at, timeZone)}`;
}

export function messageFullTimeLabel(at: number, options: MessageTimeOptions = {}): string {
  return `${format("yearMonthDayWeekday", at, options.timeZone)} ${format("time", at, options.timeZone)}`;
}
