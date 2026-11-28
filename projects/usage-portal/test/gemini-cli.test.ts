// 子プロセスへ渡す環境変数・cwd・期限切れの扱いを、偽の spawn と短命の実プロセスで固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GEMINI_CLI_TIMEOUT_MS,
  GeminiCliError,
  createGeminiCli,
  geminiHomeDir,
  geminiTokenPath,
  type SpawnGeminiOptions,
  type SpawnGeminiResult,
} from "../src/server/gemini/cli";

const dirs: string[] = [];

function tempDir(prefix = "usage-portal-gemini-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  dirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createGeminiCli", () => {
  test("PATH / HOME / TZ / 自動更新の停止だけを渡し、HOME は CREDENTIAL_DIR/antigravity にする", async () => {
    const credentialDir = tempDir();
    const seen: { command: string; args: readonly string[]; options: SpawnGeminiOptions }[] = [];
    const cli = createGeminiCli({
      credentialDir,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        GEMINI_API_KEY: "sentinel-key",
        ANTIGRAVITY_GEMINI_DIR: "/elsewhere",
        AGY_CLI_DISABLE_AUTO_UPDATE: "0",
      },
      spawn: async (command, args, options) => {
        seen.push({ command, args, options });

        return { exitCode: 0, stdout: "out", stderr: "err", timedOut: false };
      },
    });

    await expect(cli.run(["models"])).resolves.toEqual({ exitCode: 0, stdout: "out", stderr: "err" });

    const call = seen[0];

    expect(call?.command).toBe("agy");
    expect(call?.args).toEqual(["models"]);
    expect(Object.keys(call?.options.env ?? {}).sort()).toEqual(["AGY_CLI_DISABLE_AUTO_UPDATE", "HOME", "PATH", "TZ"]);
    expect(call?.options.env).toEqual({
      PATH: "/usr/bin",
      HOME: join(credentialDir, "antigravity"),
      TZ: "UTC",
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    });
    expect(call?.options.timeoutMs).toBe(GEMINI_CLI_TIMEOUT_MS);
    expect(GEMINI_CLI_TIMEOUT_MS).toBe(15_000);
  });

  test("token のパスは HOME の下の .gemini/antigravity-cli にある", () => {
    const credentialDir = "/credentials";

    expect(geminiHomeDir(credentialDir)).toBe("/credentials/antigravity");
    expect(geminiTokenPath(credentialDir)).toBe(
      "/credentials/antigravity/.gemini/antigravity-cli/antigravity-oauth-token",
    );
  });

  test("cwd は空の一時ディレクトリで、終わったら片付ける", async () => {
    let cwd: string | null = null;
    const cli = createGeminiCli({
      credentialDir: tempDir(),
      makeTempDir: () => {
        cwd = tempDir("usage-portal-gemini-run-");

        return cwd;
      },
      spawn: async (_command, _args, options) => {
        // 設定や GEMINI.md をホストの作業ディレクトリから読ませないため、cwd は空でなければならない。
        expect(readdirSync(options.cwd)).toEqual([]);

        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    await cli.run([]);

    expect(cwd).not.toBeNull();
    expect(existsSync(cwd ?? "")).toBe(false);
  });

  test("起動に失敗しても cwd を片付ける", async () => {
    let cwd: string | null = null;
    const cli = createGeminiCli({
      credentialDir: tempDir(),
      makeTempDir: () => {
        cwd = tempDir("usage-portal-gemini-run-");

        return cwd;
      },
      spawn: async () => {
        throw new Error("spawn failed");
      },
    });

    await expect(cli.run([])).rejects.toMatchObject({ reason: "spawn" });
    expect(existsSync(cwd ?? "")).toBe(false);
  });

  test("終了コードが 0 以外でも投げず、終了コードと stderr を返す", async () => {
    const cli = createGeminiCli({
      credentialDir: tempDir(),
      spawn: async () => ({ exitCode: 1, stdout: "", stderr: "Please sign in", timedOut: false }),
    });

    await expect(cli.run(["models"])).resolves.toEqual({ exitCode: 1, stdout: "", stderr: "Please sign in" });
  });

  test("期限超過と起動失敗を分類し、CLI の出力と例外文をメッセージに載せない", async () => {
    const make = (result: SpawnGeminiResult | Error) =>
      createGeminiCli({
        credentialDir: tempDir(),
        spawn: async () => {
          if (result instanceof Error) {
            throw result;
          }

          return result;
        },
      });

    await expect(
      make({ exitCode: null, stdout: "stdout-sentinel", stderr: "stderr-sentinel", timedOut: true }).run([]),
    ).rejects.toMatchObject({ reason: "timeout" });

    const error = await make(new Error("spawn sentinel: /secret/path"))
      .run([])
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(GeminiCliError);
    expect((error as GeminiCliError).reason).toBe("spawn");
    expect((error as GeminiCliError).message).not.toContain("sentinel");
    expect((error as GeminiCliError).message).not.toContain("/secret/path");

    const timeout = await make({ exitCode: null, stdout: "stdout-sentinel", stderr: "stderr-sentinel", timedOut: true })
      .run([])
      .catch((cause: unknown) => cause);

    expect((timeout as GeminiCliError).message).not.toContain("sentinel");
  });
});

// ここから先は既定の spawn（実プロセス）を使う。実資格情報とネットワークは使わない。
describe("既定の spawn", () => {
  test("標準出力・標準エラー・終了コードを受け取る", async () => {
    const cli = createGeminiCli({ credentialDir: tempDir(), binary: "sh" });

    await expect(cli.run(["-c", "echo out; echo err >&2; exit 3"])).resolves.toEqual({
      exitCode: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  test("子には絞った環境変数だけが見え、stdin は閉じている", async () => {
    const credentialDir = tempDir();
    const cli = createGeminiCli({
      credentialDir,
      binary: "sh",
      env: { PATH: process.env.PATH, HOME: "/home/test", SECRET_TOKEN: "sentinel" },
    });
    const result = await cli.run([
      "-c",
      'echo "$HOME|$TZ|$AGY_CLI_DISABLE_AUTO_UPDATE|${SECRET_TOKEN:-unset}"; cat | wc -c',
    ]);

    expect(result.stdout).toBe(`${geminiHomeDir(credentialDir)}|UTC|1|unset\n0\n`);
  });

  test("期限を過ぎた子は kill して timeout にする", async () => {
    const cli = createGeminiCli({ credentialDir: tempDir(), binary: "sleep", timeoutMs: 200 });
    const startedAt = Date.now();

    await expect(cli.run(["5"])).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test("存在しない実行ファイルは spawn として分類する", async () => {
    const cli = createGeminiCli({ credentialDir: tempDir(), binary: "/nonexistent/agy" });

    await expect(cli.run([])).rejects.toMatchObject({ reason: "spawn" });
  });

  test("期限を過ぎたとき、孫プロセスが pipe を掴んでいても待ち続けない", async () => {
    const cli = createGeminiCli({ credentialDir: tempDir(), binary: "sh", timeoutMs: 200 });
    const startedAt = Date.now();

    await expect(cli.run(["-c", "sleep 5 & wait"])).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
