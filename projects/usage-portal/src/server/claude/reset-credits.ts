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

/** 上流が「このクライアントには返さない」「今は判定できない」と答えた理由。生値は応答ごとに読み替える。 */
export type ClaudeResetCreditsRejection = "surface" | "cli_version" | "mobile" | "unavailable" | "unknown";

/** 取得経路の分類。文言は service が固定値へ写す。 */
export type ClaudeResetCreditsRead =
  | { kind: "ok"; credits: ClaudeResetCreditsValue }
  | { kind: "rejected"; rejection: ClaudeResetCreditsRejection }
  | { kind: "needs_credential" }
  | { kind: "unauthorized" }
  | { kind: "upstream" }
  | { kind: "schema" };

/**
 * `eligible: false` でも grant が無いだけと分かる理由。これ以外は判定できないので取得失敗にする。
 * 上流の値は増え得るため、知らない理由は 0 件ではなく失敗へ倒す。
 */
const CLAUDE_RESET_CREDITS_NOT_OFFERED = new Set([
  "config_off",
  "tier",
  "seat",
  "no_grant",
  "tenure",
  "other_experiment",
]);

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
 * 0 件は `eligible: false` の理由が `CLAUDE_RESET_CREDITS_NOT_OFFERED` のときと、`grants` が空・未設定のときだけ。
 * `cedar_ember` や grant の形が読めない応答（`ends_at` の欠落を含む）と、判定できない理由は null（取得失敗）に
 * して、前回の値を 0 件で上書きしない。
 */
export function parseClaudeResetCredits(body: unknown, now: number): ClaudeResetCreditsValue | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const cedar = (body as Record<string, unknown>).cedar_ember;

  if (typeof cedar !== "object" || cedar === null) {
    return null;
  }

  const status = cedar as Record<string, unknown>;

  // 実験の対象外は明示的に eligible: false が返る。null はクエリやフィールドの変化とみなす。
  if (typeof status.eligible !== "boolean") {
    return null;
  }

  if (!status.eligible) {
    const reason = status.ineligible_reason;

    // 0 件として保存すると、前回の値が消えるうえに原因も見えなくなる。
    return typeof reason === "string" && CLAUDE_RESET_CREDITS_NOT_OFFERED.has(reason)
      ? { available: 0, expiries: [] }
      : null;
  }

  const grants = status.grants;

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
      return null;
    }

    const record = grant as Record<string, unknown>;
    const left = record.resets_left;

    // resets_left は必須の整数。改名・型変化は「0 件」ではなく schema の変化として扱う。
    if (typeof left !== "number" || !Number.isInteger(left) || left < 0) {
      return null;
    }

    const rawEndsAt = record.ends_at;

    // `ends_at` キーの欠落は改名などの形の変化。null だけが「期限なし」を表す。
    if (rawEndsAt === undefined) {
      return null;
    }

    // 期限の無い grant は今の表示モデル（期限の一覧）で表せないため対象外にする。
    if (rawEndsAt === null) {
      continue;
    }

    if (typeof rawEndsAt !== "string") {
      return null;
    }

    const endsAt = Date.parse(rawEndsAt);

    if (!Number.isFinite(endsAt)) {
      return null;
    }

    if (left === 0 || endsAt <= now) {
      continue;
    }

    available += left;
    expiries.push(endsAt);
  }

  return { available, expiries: expiries.sort((a, b) => a - b) };
}

/** 上流の surface 判定を CLI と同じにするため、CLI の UA に Portal の UA を併記する。 */
export function claudeResetCreditsUserAgent(cliVersion: string, portalUserAgent: string): string {
  return `claude-cli/${cliVersion} (external, cli) ${portalUserAgent}`;
}

/**
 * `eligible: false` の理由が「grant が無い」ではなく拒否・判定不能なら、固定の語彙へ写す。
 * 未知の理由も `unknown` として拒否に倒し、grant の 0 件と取り違えない。
 */
export function claudeResetCreditsRejection(body: unknown): ClaudeResetCreditsRejection | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const cedar = (body as Record<string, unknown>).cedar_ember;

  if (typeof cedar !== "object" || cedar === null) {
    return null;
  }

  const status = cedar as Record<string, unknown>;

  if (status.eligible !== false) {
    return null;
  }

  const reason = status.ineligible_reason;

  if (typeof reason === "string" && CLAUDE_RESET_CREDITS_NOT_OFFERED.has(reason)) {
    return null;
  }

  switch (reason) {
    case "surface":
    case "cli_version":
    case "mobile":
    case "unavailable":
      return reason;
    default:
      return "unknown";
  }
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

  const rejection = claudeResetCreditsRejection(response.json);

  if (rejection !== null) {
    return { kind: "rejected", rejection };
  }

  const credits = parseClaudeResetCredits(response.json, options.now());

  return credits === null ? { kind: "schema" } : { kind: "ok", credits };
}
