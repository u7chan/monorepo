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
export const CODEX_NAME = "Codex";
const UPSTREAM_TIMEOUT_MS = 8_000;

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

  if (readObject(body, "credits")?.has_credits === true) {
    notes.push("クレジット残高あり");
  }

  const resetCredits = readNumber(readObject(body, "rate_limit_reset_credits"), "available_count");

  if (resetCredits !== null && resetCredits > 0) {
    notes.push(`リセット枠 ${resetCredits}回`);
  }

  return {
    provider: "codex",
    name: CODEX_NAME,
    plan: planLabel(readString(body, "plan_type")),
    capturedAt,
    limitReached: rateLimit.limit_reached === true || rateLimit.allowed === false || windowDenied,
    windows: withUniqueLabels(windows),
    notes,
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
  const response = await fetchJson(CODEX_USAGE_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      accept: "application/json",
      "user-agent": options.userAgent,
    },
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
    return parseCodexUsage(response.json, options.now());
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }

    throw new ProviderError("schema", "Codex の応答を解釈できませんでした");
  }
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

function resetAt(raw: Record<string, unknown>, capturedAt: number): number | null {
  const epochSeconds = readNumber(raw, "reset_at");

  if (epochSeconds !== null) {
    return epochSeconds > 0 ? epochSeconds * 1000 : null;
  }

  const afterSeconds = readNumber(raw, "reset_after_seconds");

  return afterSeconds !== null && afterSeconds >= 0 ? capturedAt + afterSeconds * 1000 : null;
}
