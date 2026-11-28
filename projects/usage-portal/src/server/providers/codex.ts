import { fetchJson } from "./http";
import {
  ProviderError,
  type ProviderSnapshot,
  type UsageWindow,
  readDurationSeconds,
  readNumber,
  readObject,
  readPercent,
  readString,
  windowKind,
  WINDOW_LABELS,
  withUniqueLabels,
} from "./types";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CODEX_NAME = "Codex";
const UPSTREAM_TIMEOUT_MS = 8_000;
/** リセット枠の詳細は表示の補助。CLI と同じ 5 秒で諦め、usage の回数だけを残す。 */
const RESET_CREDITS_TIMEOUT_MS = 5_000;

/** 画面に出す plan の表記。未知の値は上流の raw をそのまま出し、勝手に別名を作らない。 */
const PLAN_LABELS: Record<string, string> = {
  plus: "Plus",
  pro: "Pro",
  free: "Free",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

/**
 * `wham/usage` の応答から、percent を読めた窓だけを残す。
 * 週次が返らないアカウントでは週次の行を作らない（`—` のプレースホルダーも出さない）。
 */
export function parseCodexUsage(body: unknown, capturedAt: number): ProviderSnapshot {
  const rateLimit = readObject(body, "rate_limit");

  if (!rateLimit) {
    throw new ProviderError("schema", "Codex の応答を解釈できませんでした");
  }

  const windows: UsageWindow[] = [];
  let overflow = false;
  let windowDenied = false;

  for (const [key, id] of [
    ["primary_window", "primary"],
    ["secondary_window", "secondary"],
  ] as const) {
    const raw = readObject(rateLimit, key);
    const percent = raw ? readPercent(raw.used_percent) : null;

    if (!raw || !percent) {
      continue;
    }

    const durationSeconds = readDurationSeconds(raw.limit_window_seconds);

    windows.push({
      id,
      label: WINDOW_LABELS[windowKind(durationSeconds)],
      durationSeconds,
      usedPercent: percent.usedPercent,
      resetsAt: resetAt(raw, capturedAt),
    });

    overflow ||= percent.overflow;
    windowDenied ||= raw.allowed === false;
  }

  // 1 つも読めない応答は「利用枠が無い」ではなく schema の変化とみなし、前回の snapshot を残す。
  if (windows.length === 0) {
    throw new ProviderError("schema", "Codex の応答を解釈できませんでした");
  }

  const notes: string[] = [];

  if (overflow) {
    notes.push("上限超過");
  }

  const credits = readObject(body, "credits");
  const resetCredits = readNumber(readObject(body, "rate_limit_reset_credits"), "available_count");

  const creditNote = describeCreditBalance(credits);

  if (creditNote !== null) {
    notes.push(creditNote);
  }

  return {
    provider: "codex",
    name: CODEX_NAME,
    plan: planLabel(readString(body, "plan_type")),
    capturedAt,
    limitReached: rateLimit.limit_reached === true || rateLimit.allowed === false || windowDenied,
    windows: withUniqueLabels(windows),
    notes,
    // 期限は別の応答にしか無い。ここでは回数だけを持ち、詳細は取得側で足す。
    resetCredits: resetCredits !== null && resetCredits > 0 ? { available: resetCredits, expiries: null } : undefined,
  };
}

/**
 * 詳細 API の応答から、available な枠の期限だけを昇順で読む。
 * 期限の無い枠は含めない。形が読めない応答は「詳細なし」として null を返す。
 */
export function parseCodexResetCredits(body: unknown): number[] | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const credits = (body as Record<string, unknown>).credits;

  if (!Array.isArray(credits)) {
    return null;
  }

  const expiries: number[] = [];

  for (const credit of credits) {
    if (readString(credit, "status") !== "available") {
      continue;
    }

    const expiresAt = readIsoTime(credit, "expires_at");

    if (expiresAt !== null) {
      expiries.push(expiresAt);
    }
  }

  return expiries.sort((a, b) => a - b);
}

/** 詳細の期限を snapshot へ足す。詳細が読めないときは usage の回数をそのまま残す。 */
export function withResetCreditDetails(snapshot: ProviderSnapshot, body: unknown): ProviderSnapshot {
  if (!snapshot.resetCredits) {
    return snapshot;
  }

  const expiries = parseCodexResetCredits(body);

  if (expiries === null) {
    return snapshot;
  }

  return {
    ...snapshot,
    resetCredits: {
      available: snapshot.resetCredits.available,
      expiries,
    },
  };
}

export type CodexCredentialSource = {
  /** 未接続 / 再認証は ProviderError で返す。token と accountId はこの境界から外へ出さない。 */
  credential: () => Promise<{ accessToken: string; accountId: string }>;
};

export async function fetchCodexUsage(options: {
  source: CodexCredentialSource;
  userAgent: string;
  now: () => number;
  timeoutMs?: number;
}): Promise<ProviderSnapshot> {
  const { accessToken, accountId } = await readCredential(options.source);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    accept: "application/json",
    "user-agent": options.userAgent,
  };
  const response = await fetchJson(CODEX_USAGE_URL, {
    headers,
    timeoutMs: options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
  });

  if (!response) {
    throw new ProviderError("upstream", "Codex に接続できませんでした");
  }

  // 401 / 403 は token が失効している。サインインし直せば直るので、再サインインへ倒す。
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError("reauth_required", "Codex の再サインインが必要です");
  }

  if (response.status !== 200) {
    throw new ProviderError("upstream", `Codex の取得に失敗しました（HTTP ${response.status}）`);
  }

  try {
    return await readResetCreditDetails(
      parseCodexUsage(response.json, options.now()),
      headers,
      options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }

    throw new ProviderError("schema", "Codex の応答を解釈できませんでした");
  }
}

/**
 * リセット枠があるときだけ詳細を読む。回数 0 のアカウントへ無駄な要求を出さない。
 * 失敗は snapshot 全体を落とさず、回数だけの表示へ戻す。
 */
async function readResetCreditDetails(
  snapshot: ProviderSnapshot,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<ProviderSnapshot> {
  const resetCredits = snapshot.resetCredits;

  if (!resetCredits || resetCredits.available <= 0) {
    return snapshot;
  }

  const response = await fetchJson(CODEX_RESET_CREDITS_URL, {
    headers,
    timeoutMs: Math.min(timeoutMs, RESET_CREDITS_TIMEOUT_MS),
  });

  if (!response || response.status !== 200) {
    return snapshot;
  }

  return withResetCreditDetails(snapshot, response.json);
}

async function readCredential(source: CodexCredentialSource): Promise<{ accessToken: string; accountId: string }> {
  try {
    return await source.credential();
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }

    // SDK の例外文には token や URL が混ざり得る。分類だけを残し、文言は固定へ寄せる。
    throw new ProviderError("reauth_required", "Codex の再サインインが必要です");
  }
}

function planLabel(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }

  return PLAN_LABELS[raw.toLowerCase()] ?? raw;
}

/**
 * クレジット残高の注記。数値を読めるときは値で、読めないときは有無だけを出す。
 * `balance` は文字列で返るため、数値にならない値は「読めない」として扱う。
 */
function describeCreditBalance(credits: Record<string, unknown> | null): string | null {
  if (!credits) {
    return null;
  }

  if (credits.unlimited === true) {
    return "クレジット無制限";
  }

  const raw = readString(credits, "balance");
  const balance = raw === null ? Number.NaN : Number(raw);

  if (Number.isFinite(balance)) {
    return `クレジット残高 ${Math.round(balance)}`;
  }

  return credits.has_credits === true ? "クレジット残高あり" : null;
}

function resetAt(raw: Record<string, unknown>, capturedAt: number): number | null {
  const epochSeconds = readNumber(raw, "reset_at");

  if (epochSeconds !== null) {
    return epochSeconds > 0 ? epochSeconds * 1000 : null;
  }

  const afterSeconds = readNumber(raw, "reset_after_seconds");

  return afterSeconds !== null && afterSeconds >= 0 ? capturedAt + afterSeconds * 1000 : null;
}

function readIsoTime(value: unknown, key: string): number | null {
  const raw = readString(value, key);

  if (raw === null) {
    return null;
  }

  const at = Date.parse(raw);

  return Number.isFinite(at) ? at : null;
}
