/**
 * 作業フォルダが属する repo のブランチ (GET /v1/files/git)。読み取り専用で、実行は実行環境の診断
 * (runtime-info) と同じ経路に限る: 信頼ディレクトリで解決した実体 + 固定引数 (shell 無し) +
 * process.env を継承しない最小環境。repo の外 / git が無い / 期限内に答えない場合は branch: null を
 * 返し、その理由は UI に出さない (ブランチは一覧の表示を止める情報ではない)。
 */
import { spawn } from "node:child_process";
import type { SandboxGitInfo } from "./protocol";
import { killProcessTree, resolveTrustedExecutable, RUNTIME_PROBE_PATH_DIRS, runtimeProbeEnv } from "./runtime-info";

/** 2 コマンド分を合わせた期限。git は解決済みのパスを読むだけなので短く切る */
export const GIT_INFO_TIMEOUT_MS = 2_000;
/** stdout + stderr の合計上限。返すのは 1 行だけなので、超過は結果を捨てる */ export const GIT_INFO_MAX_OUTPUT_BYTES =
  4 * 1024;
/** 子プロセスの cwd。ワークスペース内の設定を cwd 経由で読ませないための固定値 (診断と同じ) */
export const GIT_INFO_CWD = "/";

export interface GitInfoOptions {
  /** テスト用の差し替え。既定は RUNTIME_PROBE_PATH_DIRS (診断と同じ信頼ディレクトリ) */
  pathDirs?: readonly string[];
  /** テスト用の差し替え。既定は信頼ディレクトリから解決した git */
  gitPath?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * 1 実行。stdout と stderr を上限まで読み、exit 0 のときだけ stdout を返す。起動失敗 / 非 0 終了 /
 * 期限超過 / 上限超過は null (git のエラー文言は理由に使わない)。
 */
function runGitCommand(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    // 上限は stdout + stderr の合計で数える (どちらも読み切る)。値として取り出すのは stdout だけ。
    // stderr の警告を branch に混ぜない (`core.fsyncObjectFiles` 非推奨の警告は終了コード 0 でも出る)
    let stdout = "";
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
    /** 上限を超えたらプロセスを殺して null で確定する。stdout 側は書き込まない */
    const countBytes = (chunk: Buffer): boolean => {
      bytes += chunk.byteLength;
      if (bytes <= maxOutputBytes) return true;
      killProcessTree(child);
      finish(null);
      return false;
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (countBytes(chunk)) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      countBytes(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout : null));
  });
}
/** 出力から 1 行目だけを取る。git は複数行を返しうるが、ブランチ名も短縮 SHA も 1 行 */
function firstLine(output: string): string | null {
  const line = output.split("\n", 1)[0]?.trim();
  return line ? line : null;
}

/**
 * HEAD が指すブランチ名。detached HEAD は指すブランチが無いため短縮 SHA を返す。
 * `symbolic-ref` は初回コミット前の repo でもブランチ名を返し、`rev-parse --short` は
 * detached HEAD でだけ成功する (1 回目の失敗が detached か repo の外かは区別しない)。
 */
export async function readWorkspaceGitInfo(directory: string, options: GitInfoOptions = {}): Promise<SandboxGitInfo> {
  const pathDirs = options.pathDirs ?? RUNTIME_PROBE_PATH_DIRS;
  const executable = options.gitPath ?? resolveTrustedExecutable("git", pathDirs);
  // git が無い環境でも 200 + null にする (UI はチップを出さない)
  if (!executable) return { branch: null };

  const env = runtimeProbeEnv(pathDirs);
  const cwd = options.cwd ?? GIT_INFO_CWD;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_INFO_MAX_OUTPUT_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? GIT_INFO_TIMEOUT_MS);
  const remaining = (): number => deadline - Date.now();

  const branch = await runGitCommand(
    executable,
    ["-C", directory, "symbolic-ref", "--short", "-q", "HEAD"],
    env,
    cwd,
    remaining(),
    maxOutputBytes,
  );
  const name = branch === null ? null : firstLine(branch);
  if (name) return { branch: name };
  // 期限を使い切っていたら 2 つ目は撃たない (時間は 1 リクエストぶんに収める)
  if (remaining() <= 0) return { branch: null };

  const commit = await runGitCommand(
    executable,
    ["-C", directory, "rev-parse", "--short", "HEAD"],
    env,
    cwd,
    remaining(),
    maxOutputBytes,
  );
  return { branch: commit === null ? null : firstLine(commit) };
}
