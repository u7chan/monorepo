import { ClaudeCliError, type ClaudeCli } from "../claude/cli";
import {
  ProviderError,
  WINDOW_LABELS,
  readPercent,
  withUniqueLabels,
  type ProviderSnapshot,
  type UsageWindow,
} from "./types";

export const CLAUDE_NAME = "Claude";
/** 取得からこの時間を過ぎたら stale。画面を開いたときの自動取得もこの間隔を空ける。 */
export const CLAUDE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** `/usage` はモデルを呼ばず、セッションも残さない。 */
export const CLAUDE_USAGE_ARGS: readonly string[] = [
  "-p",
  "/usage",
  "--output-format",
  "json",
  "--no-session-persistence",
];
export const CLAUDE_AUTH_ARGS: readonly string[] = ["auth", "status", "--json"];

/** CLI が返す窓の見出し。モデル別の週次（Max / Team）は実機で確かめるまで読まない。 */
const WINDOWS = [
  { title: "Current session", id: "rolling", durationSeconds: 18_000 },
  { title: "Current week (all models)", id: "weekly", durationSeconds: 604_800 },
] as const;

/** 画面に出す plan の表記。未知の値は上流の raw をそのまま出し、勝手に別名を作らない。 */
const PLAN_LABELS: Record<string, string> = { free: "Free", pro: "Pro", max: "Max" };

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

type ParsedDate = { month: number; day: number; year: number | null; hour: number; minute: number };

/**
 * `/usage` の `result` 文字列から、割合を読めた窓だけを作る。1 つも読めなければ schema エラー。
 * 出力本文はここから外へ出さない（DB・ログ・応答に残さない）。
 */
export function parseClaudeUsage(
  result: string,
  options: { capturedAt: number; plan: string | null },
): ProviderSnapshot {
  const lines = result.split("\n").map(normalizeLine);
  const windows: UsageWindow[] = [];
  let overflow = false;

  for (const definition of WINDOWS) {
    const line = findWindowLine(lines, definition.title);

    if (line === null) {
      continue;
    }

    const percent = readUsedPercent(line);

    if (percent === null) {
      continue;
    }

    windows.push({
      id: definition.id,
      label: WINDOW_LABELS[definition.id],
      durationSeconds: definition.durationSeconds,
      usedPercent: percent.usedPercent,
      resetsAt: readResetAt(line, options.capturedAt),
    });

    overflow ||= percent.overflow;
  }

  // 挨拶だけ、または未ログイン時の別文面が返ったときは「0%」ではなく schema の変化とみなす。
  if (windows.length === 0) {
    throw new ProviderError("schema", "Claude の出力を解釈できませんでした");
  }

  return {
    provider: "claude",
    name: CLAUDE_NAME,
    plan: options.plan,
    capturedAt: options.capturedAt,
    limitReached: windows.some((window) => window.usedPercent >= 100),
    windows: withUniqueLabels(windows),
    notes: overflow ? ["上限超過"] : [],
  };
}

/** `auth status` の出力から、接続の判定に使う 4 つだけを読む。メールや組織の情報は捨てる。 */
export type ClaudeAuth = {
  status: "not_connected" | "subscription_required" | "reauth_required" | "connected";
  plan: string | null;
};

export function readClaudeAuth(body: unknown, now: number): ClaudeAuth | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const record = body as Record<string, unknown>;

  if (typeof record.loggedIn !== "boolean") {
    return null;
  }

  if (!record.loggedIn) {
    return { status: "not_connected", plan: null };
  }

  // claude.ai 以外（API キー・ゲートウェイなど）は利用枠の窓を返さない。
  if (record.authMethod !== "claude.ai") {
    return { status: "subscription_required", plan: null };
  }

  const expiresAt = readTimestamp(record.loginExpiresAt);
  const subscriptionType = typeof record.subscriptionType === "string" ? record.subscriptionType : null;

  // 期限を読めない出力では再サインインを促さない。`/usage` の成否で決める。
  if (expiresAt !== null && expiresAt <= now) {
    return { status: "reauth_required", plan: planLabel(subscriptionType) };
  }

  return { status: "connected", plan: planLabel(subscriptionType) };
}

export function claudeAuthError(auth: ClaudeAuth): ProviderError | null {
  switch (auth.status) {
    case "not_connected":
      return new ProviderError("not_connected", "Claude にサインインしていません");
    case "subscription_required":
      return new ProviderError("subscription_required", "Claude の Pro / Max でのサインインが必要です");
    case "reauth_required":
      return new ProviderError("reauth_required", "Claude のサインインの期限が切れています");
    default:
      return null;
  }
}

/**
 * 公式 CLI を 2 回呼ぶ。接続を確かめてから `/usage` を起動し、止める理由があれば `/usage` は呼ばない。
 */
export async function fetchClaudeUsage(options: { cli: ClaudeCli; now: () => number }): Promise<ProviderSnapshot> {
  const authBody = await runJson(options.cli, CLAUDE_AUTH_ARGS);
  const auth = readClaudeAuth(authBody, options.now());

  if (auth === null) {
    throw new ProviderError("schema", "Claude の接続状態を解釈できませんでした");
  }

  const error = claudeAuthError(auth);

  if (error) {
    throw error;
  }

  const usageBody = await runJson(options.cli, CLAUDE_USAGE_ARGS);
  const result = readResultText(usageBody);

  if (result === null) {
    throw new ProviderError("schema", "Claude の出力を解釈できませんでした");
  }

  return parseClaudeUsage(result, { capturedAt: options.now(), plan: auth.plan });
}

async function runJson(cli: ClaudeCli, args: readonly string[]): Promise<unknown> {
  let stdout: string;

  try {
    stdout = await cli.run(args);
  } catch (error) {
    if (error instanceof ClaudeCliError) {
      throw cliError(error);
    }

    // 例外文にはパスや環境が混ざり得る。分類だけを残し、文言は固定へ寄せる。
    throw new ProviderError("upstream", "Claude から利用枠を取得できませんでした");
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new ProviderError("schema", "Claude の出力を解釈できませんでした");
  }
}

function cliError(error: ClaudeCliError): ProviderError {
  if (error.reason === "spawn") {
    return new ProviderError("config", "Claude の CLI を実行できませんでした");
  }

  return new ProviderError("upstream", "Claude の CLI から利用枠を取得できませんでした");
}

/** `--output-format json` の `result` だけを使う。ほかのフィールドは読まない。 */
function readResultText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const result = (body as Record<string, unknown>).result;

  return typeof result === "string" && result.trim() !== "" ? result : null;
}

function normalizeLine(line: string): string {
  return line.replace(/[\s\u00a0]+/g, " ").trim();
}

function findWindowLine(lines: readonly string[], title: string): string | null {
  const prefix = `${title.toLowerCase()}:`;

  return lines.find((line) => line.toLowerCase().startsWith(prefix)) ?? null;
}

function readUsedPercent(line: string): { usedPercent: number; overflow: boolean } | null {
  const match = line.match(/(\d+(?:\.\d+)?)% used/i);

  if (!match || match[1] === undefined) {
    return null;
  }

  return readPercent(Number(match[1]));
}

function readResetAt(line: string, now: number): number | null {
  const match = line.match(/\bresets\s+(.+?)\s*\(([^()]+)\)\s*$/i);

  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }

  return parseClaudeResetDate(match[1], match[2], now);
}

/**
 * `Nov 19, 12:50am` / `Nov 25, 6am` / `Jan 2, 2027, 3am` を、括弧内のタイムゾーンで解釈する。
 * 年と時刻の区切りは `, ` と ` at ` のどちらも受ける。年が無ければ、今より後で最も近い日時を採る。
 */
export function parseClaudeResetDate(text: string, timeZone: string, now: number): number | null {
  const parsed = readWallClock(text);

  if (parsed === null) {
    return null;
  }

  if (parsed.year !== null) {
    return zonedTimeToEpoch({ ...parsed, year: parsed.year }, timeZone);
  }

  const currentYear = yearInTimeZone(now, timeZone);

  if (currentYear === null) {
    return null;
  }

  const thisYear = zonedTimeToEpoch({ ...parsed, year: currentYear }, timeZone);

  if (thisYear !== null && thisYear > now) {
    return thisYear;
  }

  return zonedTimeToEpoch({ ...parsed, year: currentYear + 1 }, timeZone);
}

function readWallClock(text: string): ParsedDate | null {
  const match = text
    .trim()
    .replace(/\s+at\s+/i, ", ")
    .match(/^([A-Za-z]{3})\s+(\d{1,2})(?:,\s*(\d{4}))?,\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);

  if (!match) {
    return null;
  }

  const month = MONTHS[(match[1] ?? "").toLowerCase()];
  const day = Number(match[2]);
  const hour12 = Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const isPm = (match[6] ?? "").toLowerCase() === "pm";

  if (
    month === undefined ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hour12) ||
    hour12 < 1 ||
    hour12 > 12 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return {
    month,
    day,
    year: match[3] === undefined ? null : Number(match[3]),
    hour: hour12 === 12 ? (isPm ? 12 : 0) : isPm ? hour12 + 12 : hour12,
    minute,
  };
}

function planLabel(subscriptionType: string | null): string | null {
  if (subscriptionType === null) {
    return null;
  }

  return PLAN_LABELS[subscriptionType.toLowerCase()] ?? subscriptionType;
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (formatters.has(timeZone)) {
    return formatters.get(timeZone) ?? null;
  }

  let formatter: Intl.DateTimeFormat | null = null;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    // IANA の名前でない（出力の変化・未知の値）ときは、その行のリセットだけを落とす。
    formatter = null;
  }

  formatters.set(timeZone, formatter);

  return formatter;
}

function zonedParts(instant: number, timeZone: string): ZonedParts | null {
  const formatter = zonedFormatter(timeZone);

  if (formatter === null) {
    return null;
  }

  const parts = formatter.formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function yearInTimeZone(instant: number, timeZone: string): number | null {
  return zonedParts(instant, timeZone)?.year ?? null;
}

function timeZoneOffsetMs(instant: number, timeZone: string): number | null {
  const parts = zonedParts(instant, timeZone);

  if (parts === null) {
    return null;
  }

  const truncated = Math.floor(instant / 1000) * 1000;

  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - truncated;
}

/**
 * 壁時計の時刻を、そのタイムゾーンの瞬間へ直す。オフセットを 2 回取り直すのは、
 * 夏時間の切り替えを跨ぐ日時で 1 回目の見積もりがずれるため。
 */
function zonedTimeToEpoch(wall: WallClock, timeZone: string): number | null {
  const asUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  const firstOffset = timeZoneOffsetMs(asUtc, timeZone);

  if (firstOffset === null) {
    return null;
  }

  const first = asUtc - firstOffset;
  const secondOffset = timeZoneOffsetMs(first, timeZone);

  if (secondOffset === null) {
    return null;
  }

  const epoch = asUtc - secondOffset;
  const check = zonedParts(epoch, timeZone);

  // 存在しない日時（2 月 30 日など）を Date.UTC が繰り上げるのを、そのまま保存しない。
  if (
    check === null ||
    check.year !== wall.year ||
    check.month !== wall.month + 1 ||
    check.day !== wall.day ||
    check.hour !== wall.hour ||
    check.minute !== wall.minute
  ) {
    return null;
  }

  return epoch;
}
