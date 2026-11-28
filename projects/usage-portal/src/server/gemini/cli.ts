import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `CREDENTIAL_DIR` 配下に置く、CLI の `HOME`。ホストの `~/.gemini` とは共有しない。 */
export const GEMINI_HOME_DIR_NAME = "antigravity";
export const GEMINI_BINARY = "agy";
/** 上流の遅さで画面を待たせないための上限。超えた子は kill する。 */
export const GEMINI_CLI_TIMEOUT_MS = 15_000;
/** CLI 自身の自動更新を止める。版は image で固定する。 */
export const GEMINI_DISABLE_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

/** CLI が `HOME` の下へ token を置くパス。ログアウトはこのファイルを読まずに消す。 */
const TOKEN_RELATIVE_PATH = [".gemini", "antigravity-cli", "antigravity-oauth-token"] as const;

export type GeminiCliResult = { exitCode: number | null; stdout: string; stderr: string };

export type GeminiCli = {
  /**
   * 引数を渡して終了コードと出力を返す。終了コードが 0 以外でも投げない（`agy models` の未接続は exit 1 で、
   * stderr の文言で判定するため）。期限超過・起動失敗は `GeminiCliError`。
   */
  run: (args: readonly string[]) => Promise<GeminiCliResult>;
};

export type GeminiCliFailureReason = "spawn" | "timeout";

/** 失敗の分類だけを持つ。CLI の出力や例外文はメッセージに含めない。 */
export class GeminiCliError extends Error {
  readonly reason: GeminiCliFailureReason;

  constructor(reason: GeminiCliFailureReason, message: string) {
    super(message);
    this.name = "GeminiCliError";
    this.reason = reason;
  }
}

export type SpawnGeminiResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

export type SpawnGeminiOptions = {
  cwd: string;
  /** 子プロセスへ渡す環境変数。ここに含めない値は CLI から見えない。 */
  env: Record<string, string>;
  timeoutMs: number;
};

export type SpawnGemini = (
  command: string,
  args: readonly string[],
  options: SpawnGeminiOptions,
) => Promise<SpawnGeminiResult>;

export function geminiHomeDir(credentialDir: string): string {
  return join(credentialDir, GEMINI_HOME_DIR_NAME);
}

export function geminiTokenPath(credentialDir: string): string {
  return join(geminiHomeDir(credentialDir), ...TOKEN_RELATIVE_PATH);
}

type GeminiCliOptions = {
  credentialDir: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  binary?: string;
  spawn?: SpawnGemini;
  makeTempDir?: () => string;
};

/**
 * 公式 CLI を子プロセスで動かす薄い境界。渡す環境変数は `PATH` / `HOME` / `TZ` / 自動更新の停止だけに絞り、
 * cwd は空の一時ディレクトリにする。cwd の設定や GEMINI.md を CLI に読ませないため。
 */
export function createGeminiCli(options: GeminiCliOptions): GeminiCli {
  const homeDir = geminiHomeDir(options.credentialDir);
  const baseEnv = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? GEMINI_CLI_TIMEOUT_MS;
  const binary = options.binary ?? GEMINI_BINARY;
  const spawn = options.spawn ?? spawnGemini;
  const makeTempDir = options.makeTempDir ?? (() => mkdtempSync(join(tmpdir(), "usage-portal-gemini-")));

  return {
    run: async (args) => {
      const cwd = makeTempDir();

      try {
        const result = await spawn(binary, args, { cwd, env: childEnv(baseEnv, homeDir), timeoutMs });

        if (result.timedOut) {
          throw new GeminiCliError("timeout", "Gemini の CLI が時間内に終了しませんでした");
        }

        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        if (error instanceof GeminiCliError) {
          throw error;
        }

        throw new GeminiCliError("spawn", "Gemini の CLI を起動できませんでした");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

function childEnv(base: Record<string, string | undefined>, homeDir: string): Record<string, string> {
  const env: Record<string, string> = { HOME: homeDir, TZ: "UTC", [GEMINI_DISABLE_AUTO_UPDATE_ENV]: "1" };
  const path = base.PATH;

  if (path !== undefined && path !== "") {
    env.PATH = path;
  }

  return env;
}

/**
 * 期限を過ぎたら SIGKILL。SIGTERM は無視され得るため、出力の読み取りを閉じられなくなる。
 * 期限は子の終了ではなく出力の読み取り終了まで効かせる。直接の子が先に終わっても、孫が pipe を掴んでいれば
 * 読み取りは終わらず、ログアウトが待つ進行中の取得が解決しなくなるため。
 */
const spawnGemini: SpawnGemini = async (command, args, options) => {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, options.timeoutMs);
  });
  const finished = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr }));

  try {
    const outcome = await Promise.race([finished, deadline]);

    if (outcome === "timeout") {
      // 読み取りは待たない。孫が pipe を閉じたときに、捨てた promise の失敗が未処理にならないようにする。
      void finished.catch(() => undefined);

      return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    }

    return { ...outcome, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
};
