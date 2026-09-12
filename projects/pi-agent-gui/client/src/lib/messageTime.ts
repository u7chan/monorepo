/**
 * メッセージ時刻の表示整形。表記は日本語 UI に合わせて ja-JP 固定にする
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
  /** IANA タイムゾーン。省略時は実行環境の既定 */
  timeZone?: string;
  /** 「今日」の判定基準 (epoch ms)。省略時は現在時刻 */
  now?: number;
};

/** 常時表示の短いラベル: 今日 12:50 / 同じ年 9/5 / 別の年 2025/9/5 */
export function messageTimeLabel(at: number, options: MessageTimeOptions = {}): string {
  const { timeZone, now = Date.now() } = options;
  if (format("yearMonthDay", at, timeZone) === format("yearMonthDay", now, timeZone)) {
    return format("time", at, timeZone);
  }
  if (format("year", at, timeZone) === format("year", now, timeZone)) {
    return format("dayMonth", at, timeZone);
  }
  return format("yearMonthDay", at, timeZone);
}

/** ホバー (title) 用の完全な日時: 2026/9/5(土) 12:50 */
export function messageFullTimeLabel(at: number, options: MessageTimeOptions = {}): string {
  return `${format("yearMonthDayWeekday", at, options.timeZone)} ${format("time", at, options.timeZone)}`;
}
