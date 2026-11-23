import type { ClaudeStartEffort, ClaudeStartModel } from "../../shared/claude-start";
import { ClaudeCliError, type ClaudePromptCli } from "./cli";

/** 送る文は固定。時刻などの可変値は足さない（理由は docs/adr/claude-integration.md）。 */
export const CLAUDE_START_PROMPT = "Reply with a single period.";
export const CLAUDE_START_SYSTEM_PROMPT = "Reply with exactly one character.";

/** 上限（429）は失敗ではなく見送りとして扱うため、ほかの失敗と分けて返す。 */
export type ClaudeStartSendError =
  | "reauth_required"
  | "limit_reached"
  | "model_unavailable"
  | "timeout"
  | "config"
  | "unavailable";

export type ClaudeStartSendResult = { ok: true } | { ok: false; error: ClaudeStartSendError };

/**
 * 既定のシステムプロンプト・ツール・MCP・設定ファイル・スラッシュコマンドを外し、1 文字だけ返させる。
 * 外さないと、1 回の送信に既定のシステムプロンプトとツール定義の数万トークンが載る。
 */
export function claudeStartArgs(model: ClaudeStartModel, effort: ClaudeStartEffort): string[] {
  return [
    "-p",
    CLAUDE_START_PROMPT,
    "--model",
    model,
    "--effort",
    effort,
    "--system-prompt",
    CLAUDE_START_SYSTEM_PROMPT,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
}

/** 応答本文（`result`）は読まない。成否は終了コードと `is_error`、分類は `api_error_status` だけで決める。 */
export async function sendClaudeStart(
  cli: ClaudePromptCli,
  model: ClaudeStartModel,
  effort: ClaudeStartEffort,
): Promise<ClaudeStartSendResult> {
  let result: { exitCode: number | null; stdout: string };

  try {
    result = await cli.run(claudeStartArgs(model, effort));
  } catch (error) {
    if (error instanceof ClaudeCliError) {
      return { ok: false, error: error.reason === "timeout" ? "timeout" : "config" };
    }

    return { ok: false, error: "unavailable" };
  }

  const body = readBody(result.stdout);

  if (result.exitCode === 0 && body !== null && body.isError === false) {
    return { ok: true };
  }

  return { ok: false, error: classifyStatus(body?.status ?? null) };
}

export function classifyStatus(status: number | null): ClaudeStartSendError {
  switch (status) {
    case 401:
    case 403:
      return "reauth_required";
    case 429:
      return "limit_reached";
    case 400:
    case 404:
      return "model_unavailable";
    default:
      return "unavailable";
  }
}

function readBody(stdout: string): { isError: boolean | null; status: number | null } | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  return {
    isError: typeof record.is_error === "boolean" ? record.is_error : null,
    status: typeof record.api_error_status === "number" ? record.api_error_status : null,
  };
}
