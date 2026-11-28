import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `CREDENTIAL_DIR` 配下に置く CLI の設定ディレクトリ名。ホストの `~/.claude` とは共有しない。 */
export const CLAUDE_CONFIG_DIR_NAME = "claude";
export const CLAUDE_BINARY = "claude";
/** 上流の遅さで画面を待たせないための上限。超えた子は kill する。 */
export const CLAUDE_CLI_TIMEOUT_MS = 15_000;
/** 推論を伴う送信の上限。`/usage` の 15 秒では、混雑時の 1 文字の応答も待てないことがある。 */
export const CLAUDE_PROMPT_TIMEOUT_MS = 60_000;
/** リセット枠の取得に載せる CLI の版を読む。出力は `2.1.332 (Claude Code)` の形。 */
export const CLAUDE_VERSION_ARGS: readonly string[] = ["--version"];

export type ClaudeCli = {
  /** 引数を渡して標準出力を返す。終了コードが 0 以外・期限超過・起動失敗は `ClaudeCliError`。 */
  run: (args: readonly string[]) => Promise<string>;
};

/** 送信用。失敗時も JSON の `api_error_status` を読むため、終了コードが 0 以外でも stdout を返す。 */
export type ClaudePromptCli = {
  run: (args: readonly string[]) => Promise<{ exitCode: number | null; stdout: string }>;
};

export type ClaudeCliFailureReason = "spawn" | "timeout" | "exit";

/** 失敗の分類だけを持つ。CLI の出力や例外文はメッセージに含めない。 */
export class ClaudeCliError extends Error {
  readonly reason: ClaudeCliFailureReason;

  constructor(reason: ClaudeCliFailureReason, message: string) {
    super(message);
    this.name = "ClaudeCliError";
    this.reason = reason;
  }
}

export type SpawnClaudeResult = { exitCode: number | null; stdout: string; timedOut: boolean };

export type SpawnClaudeOptions = {
  cwd: string;
  /** 子プロセスへ渡す環境変数。ここに含めない値は CLI から見えない。 */
  env: Record<string, string>;
  timeoutMs: number;
};

export type SpawnClaude = (
  command: string,
  args: readonly string[],
  options: SpawnClaudeOptions,
) => Promise<SpawnClaudeResult>;

export function claudeConfigDir(credentialDir: string): string {
  return join(credentialDir, CLAUDE_CONFIG_DIR_NAME);
}

/** `2.1.332 (Claude Code)` のような出力から版だけを読む。読めなければ null。 */
export function parseClaudeVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/);

  return match?.[1] ?? null;
}

/** 版は UA に載せるためだけに読む。読めなくても他へ影響しないので、失敗は null へ丸める。 */
export async function readClaudeVersion(cli: ClaudeCli): Promise<string | null> {
  try {
    return parseClaudeVersion(await cli.run(CLAUDE_VERSION_ARGS));
  } catch {
    return null;
  }
}

/**
 * 公式 CLI を子プロセスで動かす薄い境界。渡す環境変数は `PATH` / `HOME` / `CLAUDE_CONFIG_DIR` / `TZ` だけに絞り、
 * cwd は空の一時ディレクトリにする。cwd の `CLAUDE.md` や設定を CLI に読ませないため。
 */
export function createClaudeCli(options: ClaudeCliOptions): ClaudeCli {
  const invoke = createInvoker(options, CLAUDE_CLI_TIMEOUT_MS);

  return {
    run: async (args) => {
      const result = await invoke(args);

      if (result.exitCode !== 0) {
        throw new ClaudeCliError("exit", "Claude の CLI が失敗しました");
      }

      return result.stdout;
    },
  };
}

/** 送信用の CLI。環境変数と cwd の絞り方は `createClaudeCli` と同じで、期限だけが長い。 */
export function createClaudePromptCli(options: ClaudeCliOptions): ClaudePromptCli {
  return { run: createInvoker(options, CLAUDE_PROMPT_TIMEOUT_MS) };
}

type ClaudeCliOptions = {
  credentialDir: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  binary?: string;
  spawn?: SpawnClaude;
  makeTempDir?: () => string;
};

function createInvoker(
  options: ClaudeCliOptions,
  defaultTimeoutMs: number,
): (args: readonly string[]) => Promise<{ exitCode: number | null; stdout: string }> {
  const configDir = claudeConfigDir(options.credentialDir);
  const baseEnv = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const binary = options.binary ?? CLAUDE_BINARY;
  const spawn = options.spawn ?? spawnClaude;
  const makeTempDir = options.makeTempDir ?? (() => mkdtempSync(join(tmpdir(), "usage-portal-claude-")));

  return async (args) => {
    const cwd = makeTempDir();

    try {
      const result = await spawn(binary, args, { cwd, env: childEnv(baseEnv, configDir), timeoutMs });

      if (result.timedOut) {
        throw new ClaudeCliError("timeout", "Claude の CLI が時間内に終了しませんでした");
      }

      return { exitCode: result.exitCode, stdout: result.stdout };
    } catch (error) {
      if (error instanceof ClaudeCliError) {
        throw error;
      }

      throw new ClaudeCliError("spawn", "Claude の CLI を起動できませんでした");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

function childEnv(base: Record<string, string | undefined>, configDir: string): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDir, TZ: "UTC" };

  for (const name of ["PATH", "HOME"] as const) {
    const value = base[name];

    if (value !== undefined && value !== "") {
      env[name] = value;
    }
  }

  return env;
}

/** 期限を過ぎたら SIGKILL。SIGTERM は無視され得るため、stdout の読み取りを閉じられなくなる。 */
const spawnClaude: SpawnClaude = async (command, args, options) => {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);

  const stdout = new Response(child.stdout).text();

  try {
    const exitCode = await child.exited;

    if (timedOut) {
      // 孫プロセスが pipe を掴んだままでも、期限を過ぎた結果は待たない。
      void stdout.catch(() => undefined);

      return { exitCode, stdout: "", timedOut: true };
    }

    return { exitCode, stdout: await stdout, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
};
