import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchJson } from "../providers/http";
import { claudeConfigDir } from "./cli";

export const CLAUDE_RESET_CREDITS_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
/** OAuth の usage API は CLI と同じ beta を要求する。 */
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const UPSTREAM_TIMEOUT_MS = 15_000;
/** 期限切れ間際の token を使い回さないための余裕。 */
const EXPIRY_SKEW_MS = 60_000;

export type ClaudeResetCreditsValue = { available: number; expiries: number[] };

/** 取得経路の分類。文言は service が固定値へ写す。 */
export type ClaudeResetCreditsRead =
  | { kind: "ok"; credits: ClaudeResetCreditsValue }
  | { kind: "needs_credential" }
  | { kind: "unauthorized" }
  | { kind: "upstream" }
  | { kind: "schema" };

/**
 * CLI が保存した access token を読む。Portal は書き換えない（refresh は CLI に任せる）。
 * token は戻り値の外へ出さず、保存・ログ・応答には残さない。
 */
export function readClaudeAccessToken(credentialDir: string, now: number): string | null {
  try {
    const raw = readFileSync(join(claudeConfigDir(credentialDir), ".credentials.json"), "utf8");
    const body: unknown = JSON.parse(raw);

    if (typeof body !== "object" || body === null) {
      return null;
    }

    const oauth = (body as Record<string, unknown>).claudeAiOauth;

    if (typeof oauth !== "object" || oauth === null) {
      return null;
    }

    const record = oauth as Record<string, unknown>;
    const token = record.accessToken;
    const expiresAt = record.expiresAt;

    if (typeof token !== "string" || token === "") {
      return null;
    }

    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now + EXPIRY_SKEW_MS) {
      return null;
    }

    return token;
  } catch {
    // 未サインイン・CLI の更新中・読めない JSON は、すべて「資格情報なし」として扱う。
    return null;
  }
}

/**
 * 詳細 API の応答から、残っている grant だけを読む。
 * `cedar_ember: null` は「枠なし」、形が読めない応答は null（取得失敗）として区別する。
 */
export function parseClaudeResetCredits(body: unknown, now: number): ClaudeResetCreditsValue | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const cedar = (body as Record<string, unknown>).cedar_ember;

  if (cedar === null) {
    return { available: 0, expiries: [] };
  }

  if (typeof cedar !== "object") {
    return null;
  }

  const grants = (cedar as Record<string, unknown>).grants;

  if (grants === undefined || grants === null) {
    return { available: 0, expiries: [] };
  }

  if (!Array.isArray(grants)) {
    return null;
  }

  let available = 0;
  const expiries: number[] = [];

  for (const grant of grants) {
    if (typeof grant !== "object" || grant === null) {
      continue;
    }

    const record = grant as Record<string, unknown>;
    const left = record.resets_left;
    const endsAt = readTime(record.ends_at);

    // 読めない行は数えない。0 回と混同しないよう、合計は読めた行だけで作る。
    if (typeof left !== "number" || !Number.isFinite(left) || endsAt === null) {
      continue;
    }

    if (left <= 0 || endsAt <= now) {
      continue;
    }

    available += Math.trunc(left);
    expiries.push(endsAt);
  }

  return { available, expiries: expiries.sort((a, b) => a - b) };
}

export async function requestClaudeResetCredits(options: {
  credentialDir: string;
  userAgent: string;
  now: () => number;
  timeoutMs?: number;
}): Promise<ClaudeResetCreditsRead> {
  const token = readClaudeAccessToken(options.credentialDir, options.now());

  if (token === null) {
    return { kind: "needs_credential" };
  }

  const response = await fetchJson(CLAUDE_RESET_CREDITS_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
      accept: "application/json",
      "user-agent": options.userAgent,
    },
    timeoutMs: options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
  });

  if (!response) {
    return { kind: "upstream" };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }

  if (response.status !== 200) {
    return { kind: "upstream" };
  }

  const credits = parseClaudeResetCredits(response.json, options.now());

  return credits === null ? { kind: "schema" } : { kind: "ok", credits };
}

function readTime(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }

  const at = Date.parse(value);

  return Number.isFinite(at) ? at : null;
}
