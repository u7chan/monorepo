/**
 * アプリが管理する global gitconfig。`~/.config/u7agent/gitconfig` を固定パスで原子的に書き、
 * bash の子プロセスへは `GIT_CONFIG_GLOBAL` と `GIT_CONFIG_NOSYSTEM=1` でだけ見せる。
 * 置き場所をワークスペースと Landlock の write root の外に固定するのは、エージェントから書き換えられない
 * ようにするため。設計は docs/sandbox.md の「Git identity」を正とする。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { gitConfigText, type GitIdentity } from "../git-identity";
import type { SandboxGitConfigStatus } from "./protocol";
import { killProcessTree, resolveTrustedExecutable, RUNTIME_PROBE_PATH_DIRS, runtimeProbeEnv } from "./runtime-info";

/** アプリの global gitconfig の置き場 (HOME 相対)。エージェントの write root に入れない固定パス */
export const GIT_CONFIG_RELATIVE_DIR = ".config/u7agent";
export const GIT_CONFIG_FILENAME = "gitconfig";

/** dubious ownership の確認 1 回の期限。bash の起動前に足すので短く切る */
export const GIT_OWNERSHIP_TIMEOUT_MS = 2000;

export interface GitConfigTarget {
  /** 解決した HOME (絶対) */
  home: string;
  /** 書く実パス (絶対) */
  path: string;
  /** 親ディレクトリ (絶対) */
  dir: string;
}

/** HOME は os.homedir() (HOME 優先・無ければ passwd) で解決し、絶対パスだけを受け付ける */
export function gitConfigTarget(home: string = homedir()): GitConfigTarget {
  const base = resolve(home);
  const dir = join(base, GIT_CONFIG_RELATIVE_DIR);
  return { home: base, dir, path: join(dir, GIT_CONFIG_FILENAME) };
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export type GitConfigFailureReason = NonNullable<SandboxGitConfigStatus["reason"]>;

export type PrepareGitConfigResult = { ok: true } | { ok: false; reason: GitConfigFailureReason };

export interface PrepareGitConfigInput {
  target: GitConfigTarget;
  identity: GitIdentity | null;
  /**
   * 書いてはいけない root (rootCwd と全 Landlock write root の lexical 形)。パスは realpath ではなく
   * 設定値のまま比較する: 比較のたびに実体を引き直すと、置き場が symlink に差し替わったときに通ってしまう。
   */
  forbiddenRoots: readonly string[];
}

/** 書く先が許可されない場所かを返す。HOME が "/" のときは `/.config/...` になるため、相対判定で弾く */
function forbiddenReason(path: string, forbiddenRoots: readonly string[]): GitConfigFailureReason | undefined {
  if (!isAbsolute(path)) return "home_unavailable";
  for (const root of forbiddenRoots) {
    if (isInside(resolve(root), path)) return "inside_workspace";
  }
  return undefined;
}

/**
 * 1 つの親ディレクトリを lstat し、symlink なら失敗にする。存在しなければ作る。
 * rename の前に毎回通すのは、内容が同じで書込を skip する場合も置き場の差し替えを検出するため。
 */
async function ensureDirectory(path: string): Promise<GitConfigFailureReason | undefined> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
    } catch {
      return "write_failed";
    }
    try {
      stats = await lstat(path);
    } catch {
      return "write_failed";
    }
  }
  if (stats.isSymbolicLink()) return "symlink";
  if (!stats.isDirectory()) return "write_failed";
  return undefined;
}

/**
 * 固定パスへ identity を書く。内容が一致すれば書かないが、比較の前にも親の symlink 検査を通す。
 * 親 (`~/.config` と `~/.config/u7agent`) のどちらかが symlink なら書かない。
 */
export async function prepareGitConfig(input: PrepareGitConfigInput): Promise<PrepareGitConfigResult> {
  // HOME が "/" のときは `/.config/...` になる。ユーザーの設定を置く場所として扱わない
  if (!isAbsolute(input.target.home) || input.target.home === sep) return { ok: false, reason: "home_unavailable" };
  const blocked = forbiddenReason(input.target.path, input.forbiddenRoots);
  if (blocked) return { ok: false, reason: blocked };
  const configRoot = join(input.target.home, ".config");
  for (const parent of [configRoot, input.target.dir]) {
    const problem = await ensureDirectory(parent);
    if (problem) return { ok: false, reason: problem };
  }
  return writeIfChanged(input.target, gitConfigText(input.identity));
}

async function writeIfChanged(target: GitConfigTarget, content: string): Promise<PrepareGitConfigResult> {
  const existing = await readExisting(target.path);
  if (existing.ok && existing.content === content) return { ok: true };
  if (!existing.ok) return { ok: false, reason: existing.reason };
  return atomicWrite(target, content);
}

async function readExisting(
  path: string,
): Promise<{ ok: true; content: string } | { ok: false; reason: GitConfigFailureReason }> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!stats.isFile()) return { ok: false, reason: "write_failed" };
    return { ok: true, content: await readFile(path, "utf-8") };
  } catch {
    // 未作成は書く対象。読めない (EACCES など) 場合は書いても直らないので失敗にする
    try {
      await lstat(path);
      return { ok: false, reason: "write_failed" };
    } catch {
      return { ok: true, content: "" };
    }
  }
}

/** temp + rename。temp は同じディレクトリに作り、rename を同一ファイルシステム内に閉じる */
async function atomicWrite(target: GitConfigTarget, content: string): Promise<PrepareGitConfigResult> {
  const temp = join(target.dir, `.${GIT_CONFIG_FILENAME}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, target.path);
    return { ok: true };
  } catch {
    return { ok: false, reason: "write_failed" };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * `git -C <cwd> rev-parse` を 1 回だけ打ち、system config の `safe.directory` を落とした副作用で
 * `dubious ownership` が出るかを調べる。出力は使わず、判定にだけ使う。
 */
export function detectDubiousOwnership(input: {
  gitPath?: string | undefined;
  cwd: string;
  configPath: string;
}): Promise<boolean> {
  const executable = input.gitPath ?? resolveTrustedExecutable("git", RUNTIME_PROBE_PATH_DIRS);
  if (!executable) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    let stderr = "";
    const finish = (dubious: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(dubious);
    };
    const child = spawn(executable, ["-C", input.cwd, "rev-parse", "--git-dir"], {
      cwd: "/",
      env: {
        ...runtimeProbeEnv(RUNTIME_PROBE_PATH_DIRS),
        GIT_CONFIG_GLOBAL: input.configPath,
        GIT_CONFIG_NOSYSTEM: "1",
      },
      shell: false,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(false);
    }, GIT_OWNERSHIP_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(/dubious ownership/i.test(stderr)));
  });
}
