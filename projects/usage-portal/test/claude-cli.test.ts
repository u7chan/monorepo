// 子プロセスへ渡す環境変数・cwd・期限切れの扱いを、偽の spawn と短命の実プロセスで固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliError, claudeConfigDir, createClaudeCli, type SpawnClaudeOptions } from "../src/server/claude/cli";

const dirs: string[] = [];

function credentialDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-claude-cli-"));

  dirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createClaudeCli", () => {
  test("PATH / HOME / CLAUDE_CONFIG_DIR / TZ だけを渡し、cwd は空の一時ディレクトリにする", async () => {
    const dir = credentialDir();
    const seen: { command: string; args: readonly string[]; options: SpawnClaudeOptions }[] = [];
    let tempDir: string | null = null;
    const cli = createClaudeCli({
      credentialDir: dir,
      env: { PATH: "/usr/bin", HOME: "/home/test", ANTHROPIC_API_KEY: "sentinel-key", CLAUDE_CONFIG_DIR: "/elsewhere" },
      makeTempDir: () => {
        tempDir = mkdtempSync(join(tmpdir(), "usage-portal-claude-run-"));

        dirs.push(tempDir);

        return tempDir;
      },
      spawn: async (command, args, options) => {
        seen.push({ command, args, options });

        // ホストの CLAUDE.md や設定を読ませないため、cwd は空でなければならない。
        expect(readdirSync(options.cwd)).toEqual([]);

        return { exitCode: 0, stdout: '{"ok":true}\n', timedOut: false };
      },
    });

    await expect(cli.run(["-p", "/usage"])).resolves.toBe('{"ok":true}\n');

    const call = seen[0];

    expect(call?.command).toBe("claude");
    expect(call?.args).toEqual(["-p", "/usage"]);
    expect(Object.keys(call?.options.env ?? {}).sort()).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TZ"]);
    expect(call?.options.env.TZ).toBe("UTC");
    expect(call?.options.env.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir(dir));
    expect(call?.options.env.CLAUDE_CONFIG_DIR).not.toBe("/elsewhere");
    expect(tempDir === null ? true : existsSync(tempDir)).toBe(false);
  });

  test("期限超過・終了コード・起動失敗を分類し、CLI の出力を例外文に載せない", async () => {
    const dir = credentialDir();
    const make = (result: { exitCode: number | null; stdout: string; timedOut: boolean } | Error) =>
      createClaudeCli({
        credentialDir: dir,
        spawn: async () => {
          if (result instanceof Error) {
            throw result;
          }

          return result;
        },
      });

    await expect(make({ exitCode: null, stdout: "sentinel", timedOut: true }).run([])).rejects.toMatchObject({
      reason: "timeout",
    });
    await expect(make({ exitCode: 1, stdout: "sentinel", timedOut: false }).run([])).rejects.toMatchObject({
      reason: "exit",
    });

    const error = await make(new Error("spawn sentinel: /secret/path"))
      .run([])
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClaudeCliError);
    expect((error as ClaudeCliError).reason).toBe("spawn");
    expect((error as ClaudeCliError).message).not.toContain("sentinel");
    expect((error as ClaudeCliError).message).not.toContain("/secret/path");
  });

  test("既定の spawn は実プロセスの標準出力を返し、cwd を片付ける", async () => {
    const dir = credentialDir();
    let tempDir: string | null = null;
    const cli = createClaudeCli({
      credentialDir: dir,
      binary: "/bin/echo",
      makeTempDir: () => {
        tempDir = mkdtempSync(join(tmpdir(), "usage-portal-claude-run-"));

        dirs.push(tempDir);

        return tempDir;
      },
    });

    await expect(cli.run(["hello"])).resolves.toBe("hello\n");
    expect(tempDir === null ? true : existsSync(tempDir)).toBe(false);
  });

  test("期限を過ぎた子は kill して timeout にする", async () => {
    const dir = credentialDir();
    const cli = createClaudeCli({ credentialDir: dir, binary: "sleep", timeoutMs: 200 });
    const startedAt = Date.now();

    await expect(cli.run(["5"])).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
