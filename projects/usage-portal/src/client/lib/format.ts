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

/** 推移の横軸や見出しに出す期間。5 時間 / 7 日のように、丸めた単位 1 つで出す。 */
export function formatSpan(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "0分";
  }

  if (milliseconds >= DAY_MS) {
    return `${Math.round(milliseconds / DAY_MS)}日`;
  }

  if (milliseconds >= HOUR_MS) {
    return `${Math.round(milliseconds / HOUR_MS)}時間`;
  }

  return `${Math.max(1, Math.round(milliseconds / MINUTE_MS))}分`;
}

/** 取得間隔。分単位の整数で出す（300000 → `5 分`）。 */
export function formatFetchInterval(milliseconds: number): string {
  return `${Math.max(1, Math.round(milliseconds / MINUTE_MS))} 分`;
}

/** 取得からの経過。稼働中の画面で「いまの値か」を判断するために使う。 */
export function describeAge(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < MINUTE_MS) {
    return "たった今";
  }

  if (milliseconds < HOUR_MS) {
    return `${Math.floor(milliseconds / MINUTE_MS)} 分前`;
  }

  if (milliseconds < DAY_MS) {
    return `${Math.floor(milliseconds / HOUR_MS)} 時間前`;
  }

  return `${Math.floor(milliseconds / DAY_MS)} 日前`;
}

/** 保存されている履歴の長さ。分だけは「分分」にならないよう単位を付けない。 */
export function describeCoverage(milliseconds: number): string {
  if (milliseconds >= DAY_MS) {
    return `${Math.round(milliseconds / DAY_MS)} 日分`;
  }

  if (milliseconds >= HOUR_MS) {
    return `${Math.round(milliseconds / HOUR_MS)} 時間分`;
  }

  return `${Math.max(1, Math.round(milliseconds / MINUTE_MS))} 分`;
}

/** ブラウザのローカル時刻で `MM/DD`。 */
export function formatMonthDay(at: number): string {
  const date = new Date(at);

  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** ブラウザのローカル時刻で `MM/DD HH:MM`。 */
export function formatDateTime(at: number): string {
  return `${formatMonthDay(at)} ${formatClock(at)}`;
}

export function formatClock(at: number): string {
  const date = new Date(at);

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ローカル時刻の暦日。夏時間で 24 時間にならない日があっても日付だけで数える。 */
export function dayIndex(at: number): number {
  const date = new Date(at);

  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/** meter の 1 行に出すリセット情報。折り返しで「あと 2 時 / 間」と割れないよう 2 つに分けて返す。 */
export function describeReset(
  resetsAt: number | null,
  now: number,
  options: { rolling?: boolean } = {},
): { at: string; remaining: string } | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) {
    return null;
  }

  const at = options.rolling ? rollingResetAt(resetsAt, now) : formatDateTime(resetsAt);

  return { at: `リセット ${at}`, remaining: `あと ${describeRemaining(resetsAt - now)}` };
}

/**
 * カードに出すリセット枠。詳細で確認できた枠だけを並べ、
 * 期限なしと期限不明を混同しない（確認できていない枠を「期限なし」と書かない）。
 */
export type ResetCreditsView = {
  label: string;
  rows: { remaining: string; at: string }[];
  /** 期限の無い枠と、確認できなかった枠の注記。 */
  notes: string[];
};

export function describeResetCredits(
  credits: { available: number; details: { expiresAt: number | null }[] | null },
  now: number,
): ResetCreditsView | null {
  if (credits.available <= 0) {
    return null;
  }

  const label = `リセット枠 ${credits.available}回`;

  if (credits.details === null) {
    return { label, rows: [], notes: [] };
  }

  const rows = credits.details
    .filter((detail): detail is { expiresAt: number } => detail.expiresAt !== null && Number.isFinite(detail.expiresAt))
    .map((detail) => detail.expiresAt)
    .sort((a, b) => a - b)
    .map((at) => ({
      remaining: at <= now ? "期限切れ" : `あと ${describeRemaining(at - now)}`,
      at: `期限 ${formatDateTime(at)}`,
    }));

  const noExpiry = credits.details.filter((detail) => detail.expiresAt === null).length;
  const unknown = Math.max(0, credits.available - credits.details.length);
  const notes: string[] = [];

  if (noExpiry > 0) {
    notes.push(`期限なし ${noExpiry}件`);
  }

  if (unknown > 0) {
    notes.push(rows.length + noExpiry > 0 ? `他 ${unknown}件は期限不明` : `期限不明 ${unknown}件`);
  }

  return { label, rows, notes };
}

/**
 * ローリングは 5 時間以内に終わる。日付は「あと N 時間」から分かるので時計だけを出し、日をまたぐときだけ「翌」を付ける。
 * 期間が読めず 2 日以上先になったときは、いつ戻るかを読み違えないよう日付ごと出す。
 */
function rollingResetAt(at: number, now: number): string {
  const days = dayIndex(at) - dayIndex(now);

  if (days <= 0) {
    return formatClock(at);
  }

  return days === 1 ? `翌 ${formatClock(at)}` : formatDateTime(at);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
