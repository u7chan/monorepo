const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 「あと」の文言。1 時間未満は分、24 時間未満は時間、それ以上は日で出す。 */
export function describeRemaining(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < MINUTE_MS) {
    return "まもなく";
  }

  if (milliseconds < HOUR_MS) {
    return `${Math.ceil(milliseconds / MINUTE_MS)} 分`;
  }

  if (milliseconds < DAY_MS) {
    return `${Math.ceil(milliseconds / HOUR_MS)} 時間`;
  }

  return `${Math.ceil(milliseconds / DAY_MS)} 日`;
}

/** 表示は整数 % に丸める。小数の 0.5% は 1% と出し、0.4% を 0% と潰さない。 */
export function formatPercent(percent: number): string {
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

export function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/** ブラウザのローカル時刻で `MM/DD HH:MM`。 */
export function formatDateTime(at: number): string {
  const date = new Date(at);

  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatClock(at: number): string {
  const date = new Date(at);

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** meter の 1 行に出すリセット情報。折り返しで「あと 2 時 / 間」と割れないよう 2 つに分けて返す。 */
export function describeReset(resetsAt: number | null, now: number): { at: string; remaining: string } | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) {
    return null;
  }

  return { at: `リセット ${formatDateTime(resetsAt)}`, remaining: `あと ${describeRemaining(resetsAt - now)}` };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
