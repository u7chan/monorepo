/**
 * サンドボックス自身の実行環境と、allowlist コマンドの実在 / バージョンの検出。
 * process.env を継承しない最小環境・信頼ディレクトリで解決した絶対パス・固定引数だけを使い、
 * 上限 (1 コマンド / 全体 / 同時数 / 出力バイト) を超えた子プロセスはプロセスグループごと殺す。
 * 何をどこまで検出するかと限界は docs/sandbox-api.md を参照する。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { arch as hostArch, userInfo } from "node:os";
import { join, sep } from "node:path";
import type { SandboxRuntimeCommand, SandboxRuntimeEnvironment, SandboxRuntimeInfo } from "./protocol";

/** 子プロセスへ渡す PATH の構成元。ワークスペースとユーザーが書き込めるディレクトリは入れない */
export const RUNTIME_PROBE_PATH_DIRS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;

/** 1 コマンドの期限 */
export const RUNTIME_PROBE_PER_COMMAND_TIMEOUT_MS = 1000;
/** 診断全体の期限 (同時実行の待ち合わせを含む) */
export const RUNTIME_PROBE_TOTAL_TIMEOUT_MS = 5000;
/** 同時に起動する子プロセスの上限 */
export const RUNTIME_PROBE_MAX_CONCURRENCY = 4;
/** stdout + stderr の合計上限。読み込み完了を待たず、ストリーム受信中に打ち切る */
export const RUNTIME_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
/** 子プロセスの cwd。ワークスペース内のファイル (設定・フック) を読ませないための固定値 */
export const RUNTIME_PROBE_CWD = "/";
/** 子プロセスの HOME。ユーザー別設定を読ませないための存在しない固定値 */
export const RUNTIME_PROBE_HOME = "/nonexistent";

export interface RuntimeProbeCommand {
  name: string;
  args: readonly string[];
}

/** 検出対象の allowlist。名前と引数の両方をここで固定し、任意のリクエスト値を実行しない */
export const RUNTIME_PROBE_COMMANDS: readonly RuntimeProbeCommand[] = [
  { name: "curl", args: ["--version"] },
  { name: "node", args: ["--version"] },
  { name: "npm", args: ["--version"] },
  { name: "npx", args: ["--version"] },
  { name: "python3", args: ["--version"] },
  { name: "uv", args: ["--version"] },
  { name: "git", args: ["--version"] },
  { name: "rg", args: ["--version"] },
  { name: "fd", args: ["--version"] },
  { name: "jq", args: ["--version"] },
  { name: "file", args: ["--version"] },
  { name: "tar", args: ["--version"] },
  { name: "gzip", args: ["--version"] },
  { name: "unzip", args: ["-v"] },
  { name: "zip", args: ["-v"] },
  { name: "xz", args: ["--version"] },
  { name: "openssl", args: ["version"] },
  { name: "bash", args: ["--version"] },
];

export interface RuntimeProbeOptions {
  /** テスト用の差し替え。既定は RUNTIME_PROBE_PATH_DIRS */
  pathDirs?: readonly string[];
  cwd?: string;
  commands?: readonly RuntimeProbeCommand[];
  perCommandTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxConcurrency?: number;
  maxOutputBytes?: number;
}

/** バージョンらしい最初のトークン (数字 + ドット 1 つ以上) だけを返す。生の出力や内部パスは返さない */
const VERSION_PATTERN = /\b(\d+(?:\.\d+){1,3})\b/;

const ARCH_NAMES: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
  arm: "armv7l",
  ia32: "i386",
  ppc64: "ppc64",
  s390x: "s390x",
  riscv64: "riscv64",
};

/** 1 セグメント名だけを通す (パス区切りや相対指定を allowlist の外から混ぜさせない) */
function isValidCommandName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name);
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * 信頼ディレクトリから実行ファイルを解決する。symlink は実体まで解決し、実体が信頼ディレクトリの外なら
 * 使わない (ワークスペースや書き込み可能な場所へ置かれた実行ファイルへのすり替えを防ぐ)。
 */
function resolveTrustedExecutable(name: string, pathDirs: readonly string[]): string | undefined {
  if (!isValidCommandName(name)) return undefined;
  const trustedRoots = pathDirs.flatMap((dir) => {
    try {
      return [realpathSync(dir)];
    } catch {
      return [];
    }
  });
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    let stats;
    try {
      stats = statSync(candidate);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!trustedRoots.some((root) => isInside(root, real))) continue;
    return real;
  }
  return undefined;
}

/**
 * 子プロセスへ渡す環境を新規作成する。process.env を継承すると PI_SANDBOX_TOKEN や LLM キー、
 * NODE_OPTIONS / LD_PRELOAD / PYTHONPATH / BASH_ENV などが診断経由で漏れる。
 */
export function runtimeProbeEnv(pathDirs: readonly string[]): NodeJS.ProcessEnv {
  return {
    PATH: pathDirs.join(":"),
    HOME: RUNTIME_PROBE_HOME,
    // 出力を言語非依存にしてバージョン抽出を安定させる
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
  };
}

/** detached で作ったプロセスグループごと殺す (シェル経由の孫プロセスを残さない) */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
    return;
  } catch {
    // グループが無い (exit 済み / 非対応プラットフォーム) 場合は子だけを殺す
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 既に終了している
  }
}

/** 生の出力からバージョンだけを取り出す。取れなければ undefined */
function extractVersion(output: string): string | undefined {
  const match = VERSION_PATTERN.exec(output);
  return match?.[1];
}

/** 1 コマンドを起動してバージョンを返す。存在しない / 取れない / 上限超過 / 期限超過は null */
function runProbeCommand(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let bytes = 0;
    const child = spawn(executable, [...args], {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const onChunk = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        // 上限はストリーム受信中に見る (読み込み完了を待たない)
        killProcessTree(child);
        finish(null);
        return;
      }
      output += chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", () => finish(null));
    child.on("close", () => finish(extractVersion(output) ?? null));
  });
}

function parseOsPrettyName(text: string): string | undefined {
  const match = /^PRETTY_NAME=(.*)$/m.exec(text);
  const value = match?.[1]?.trim().replace(/^"(.*)"$/, "$1");
  return value ? value : undefined;
}

async function osName(): Promise<string> {
  try {
    return parseOsPrettyName(await readFile("/etc/os-release", "utf8")) ?? "不明";
  } catch {
    return "不明";
  }
}

function userName(): string {
  try {
    return userInfo().username || "不明";
  } catch {
    return "不明";
  }
}

function isRootUser(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

async function environmentInfo(rootCwd: string): Promise<SandboxRuntimeEnvironment> {
  return {
    os: await osName(),
    arch: ARCH_NAMES[hostArch()] ?? hostArch(),
    user: userName(),
    isRoot: isRootUser(),
    workspace: rootCwd,
  };
}

/**
 * allowlist の各コマンドを解決し、実在するものだけを検出順 (allowlist の順) で返す。
 * 全体の期限を過ぎたら残りは起動せず、存在を確認できているコマンドは version: null として返す。
 */
export async function probeSandboxRuntime(
  rootCwd: string,
  options: RuntimeProbeOptions = {},
): Promise<SandboxRuntimeInfo> {
  const pathDirs = options.pathDirs ?? RUNTIME_PROBE_PATH_DIRS;
  const cwd = options.cwd ?? RUNTIME_PROBE_CWD;
  const commands = options.commands ?? RUNTIME_PROBE_COMMANDS;
  const perCommandTimeoutMs = options.perCommandTimeoutMs ?? RUNTIME_PROBE_PER_COMMAND_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? RUNTIME_PROBE_TOTAL_TIMEOUT_MS;
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? RUNTIME_PROBE_MAX_CONCURRENCY);
  const maxOutputBytes = options.maxOutputBytes ?? RUNTIME_PROBE_MAX_OUTPUT_BYTES;
  const env = runtimeProbeEnv(pathDirs);
  const deadline = Date.now() + totalTimeoutMs;

  const seen = new Set<string>();
  const resolved: Array<{ name: string; args: readonly string[]; executable: string | undefined }> = [];
  for (const command of commands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    resolved.push({ ...command, executable: resolveTrustedExecutable(command.name, pathDirs) });
  }

  const versions = new Map<string, string | null>();
  const runnable = resolved.filter((command) => command.executable !== undefined);
  for (let index = 0; index < runnable.length; index += maxConcurrency) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const chunk = runnable.slice(index, index + maxConcurrency);
    await Promise.all(
      chunk.map(async (command) => {
        versions.set(
          command.name,
          await runProbeCommand(
            command.executable!,
            command.args,
            env,
            cwd,
            Math.min(perCommandTimeoutMs, remainingMs),
            maxOutputBytes,
          ),
        );
      }),
    );
  }

  const detected: SandboxRuntimeCommand[] = resolved
    .filter((command) => command.executable !== undefined)
    .map((command) => ({ name: command.name, version: versions.get(command.name) ?? null }));
  return { environment: await environmentInfo(rootCwd), commands: detected };
}
