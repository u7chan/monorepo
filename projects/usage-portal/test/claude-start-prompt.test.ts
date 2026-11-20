// 開始の送信の引数と、CLI の結果の分類（成功・上限・再ログイン・モデル・期限超過）を固定する。
import { describe, expect, test } from "bun:test";
import { ClaudeCliError, type ClaudePromptCli } from "../src/server/claude/cli";
import {
  claudeStartArgs,
  sendClaudeStart,
  CLAUDE_START_PROMPT,
  type ClaudeStartSendError,
} from "../src/server/claude/start-prompt";

function cli(result: { exitCode: number | null; stdout: string } | Error, calls: string[][] = []): ClaudePromptCli {
  return {
    run: async (args) => {
      calls.push([...args]);

      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
  };
}

function json(body: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", result: "secret body", ...body });
}

describe("claudeStartArgs", () => {
  test("既定のシステムプロンプト・ツール・MCP・設定・スラッシュコマンドを外し、セッションを残さない", () => {
    const args = claudeStartArgs("haiku", "low");

    expect(args.slice(0, 2)).toEqual(["-p", CLAUDE_START_PROMPT]);
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });
});

describe("sendClaudeStart", () => {
  test("終了コード 0 で is_error が false なら成功", async () => {
    const calls: string[][] = [];

    expect(
      await sendClaudeStart(cli({ exitCode: 0, stdout: json({ is_error: false }) }, calls), "haiku", "low"),
    ).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  test.each<[number, ClaudeStartSendError]>([
    [429, "limit_reached"],
    [401, "reauth_required"],
    [403, "reauth_required"],
    [404, "model_unavailable"],
    [400, "model_unavailable"],
    [500, "unavailable"],
  ])("api_error_status %i は %s", async (status, error) => {
    const stdout = json({ is_error: true, api_error_status: status });

    expect(await sendClaudeStart(cli({ exitCode: 1, stdout }), "haiku", "low")).toEqual({ ok: false, error });
  });

  test("終了コード 0 でも is_error が true なら失敗", async () => {
    const stdout = json({ is_error: true, api_error_status: 429 });

    expect(await sendClaudeStart(cli({ exitCode: 0, stdout }), "haiku", "low")).toEqual({
      ok: false,
      error: "limit_reached",
    });
  });

  test("JSON でない出力は unavailable にし、本文を返さない", async () => {
    const result = await sendClaudeStart(cli({ exitCode: 1, stdout: "secret body" }), "haiku", "low");

    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("期限超過は timeout、起動できなければ config", async () => {
    expect(await sendClaudeStart(cli(new ClaudeCliError("timeout", "x")), "haiku", "low")).toEqual({
      ok: false,
      error: "timeout",
    });
    expect(await sendClaudeStart(cli(new ClaudeCliError("spawn", "x")), "haiku", "low")).toEqual({
      ok: false,
      error: "config",
    });
  });
});
