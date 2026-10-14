/**
 * 呼び出しごとの一時領域 (HOME / TMPDIR) と、終了済み呼び出しの回収。
 * 置き場の名前が所有者 (pid と起動時刻) を表すので、プロセスが残っているかを別プロセスからも判定できる。
 * 外側の abort は SIGKILL で finally が走らないため、回収は次の起動時の掃除に寄せる。
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { processStartedAtMs } from "../proc-stat";

/** bash の Landlock 許可 root (/tmp) の内側に固定する。HOME / TMPDIR / プロファイルを内包する */
export const BROWSER_TEMP_ROOT = "/tmp/u7agent-browser";

export interface CallOwner {
  pid: number;
  startedAtMs: number;
}

export interface CallDirs {
  /** 呼び出し全体。削除はここだけで足りる (Playwright のプロファイルも TMPDIR の内側にできる) */
  root: string;
  home: string;
  tmp: string;
}

/** 起動時刻の読み取り。undefined = 終了済み、0 = 不明、例外 = 不明 (生存として扱う) */
export type ProcessStartTimeReader = (pid: number) => Promise<number | undefined>;

export function callDirName(owner: CallOwner): string {
  return `${owner.pid}-${owner.startedAtMs}`;
}

/**
 * 入場のための一時ファイルの名前。所有者を書いてから `link` で枠にする (呼び出しの置き場の直下に置き、
 * `slots/` には入場済みの枠だけが並ぶようにする)。`unique` は同じ所有者の同時実行を区別する
 */
export function claimFileName(owner: CallOwner, unique: string): string {
  return `.claim-${callDirName(owner)}-${unique}`;
}

/** 一時ファイルの名前から所有者を戻す。形が違う名前は対象外にする */
export function parseClaimFileName(name: string): CallOwner | undefined {
  const match = /^\.claim-(\d+)-(\d+)-/.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const startedAtMs = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedAtMs)) return undefined;
  return { pid, startedAtMs };
}

/** 名前が所有者を表していないディレクトリは対象外にする (他のツールの置き場を巻き込まない) */
export function parseCallDirName(name: string): CallOwner | undefined {
  const match = /^(\d+)-(\d+)$/.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const startedAtMs = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedAtMs)) return undefined;
  return { pid, startedAtMs };
}

/**
 * 所有者の状態。終了済み (`gone`) と確認できるのは「プロセスが居ない」か「PID が再利用された」ときだけで、
 * 起動時刻が読めない (0 / EACCES などの読み取り失敗) ときは不明として生存と同じ側へ倒す。
 */
export type CallOwnerState = "alive" | "gone" | "unknown";

export async function callOwnerState(
  owner: CallOwner,
  readStartedAt: ProcessStartTimeReader = processStartedAtMs,
): Promise<CallOwnerState> {
  let current: number | undefined;
  try {
    current = await readStartedAt(owner.pid);
  } catch {
    return "unknown";
  }
  if (current === undefined) return "gone";
  if (current === 0) return "unknown";
  return current === owner.startedAtMs ? "alive" : "gone";
}

/** 生存 (不明を含む) として扱うか。消してよいのは `gone` と確認できたときだけ */
export async function isCallOwnerAlive(
  owner: CallOwner,
  readStartedAt: ProcessStartTimeReader = processStartedAtMs,
): Promise<boolean> {
  return (await callOwnerState(owner, readStartedAt)) !== "gone";
}

/** 終了済みと確認できる呼び出しの置き場だけを消す。削除の失敗は警告に留め、呼び出し元は続行する */
export async function cleanupStaleCallDirs(
  options: {
    root?: string;
    readStartedAt?: ProcessStartTimeReader;
    log?: (message: string) => void;
  } = {},
): Promise<string[]> {
  const root = options.root ?? BROWSER_TEMP_ROOT;
  const readStartedAt = options.readStartedAt ?? processStartedAtMs;
  const log = options.log ?? (() => {});
  const entries = await readdir(root).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const entry of entries) {
    // 入場の一時ファイルは、入場が SIGKILL で中断されたときだけ残る。枠と同じく確定した終了だけで消す
    const claim = parseClaimFileName(entry);
    if (claim) {
      if ((await callOwnerState(claim, readStartedAt)) === "gone") await rm(join(root, entry), { force: true });
      continue;
    }
    const owner = parseCallDirName(entry);
    if (!owner) continue;
    if ((await callOwnerState(owner, readStartedAt)) !== "gone") continue;
    try {
      await rm(join(root, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch (error) {
      log(`古い一時領域を削除できませんでした (${entry}): ${(error as Error).message}`);
    }
  }
  return removed;
}

/**
 * 自分の所有者 (pid と起動時刻)。起動時刻を読めない (/proc が無い・EACCES など) ときは呼び出しを始めない:
 * 読み取りの失敗を「居ない」と取り違えると、他の呼び出しの置き場を回収しかねない。
 */
export async function readCallOwner(
  options: { pid?: number; readStartedAt?: ProcessStartTimeReader } = {},
): Promise<CallOwner> {
  const pid = options.pid ?? process.pid;
  const readStartedAt = options.readStartedAt ?? processStartedAtMs;
  let startedAtMs: number | undefined;
  try {
    startedAtMs = await readStartedAt(pid);
  } catch (error) {
    throw new Error(`プロセス ${pid} の起動時刻を /proc から読めません: ${(error as Error).message}`);
  }
  if (!startedAtMs) throw new Error(`プロセス ${pid} の起動時刻を /proc から読めません`);
  return { pid, startedAtMs };
}

/** 自分の呼び出し用の領域を作る。名前は自分の pid と起動時刻で、他の呼び出しの掃除から生存と判定される */
export async function createCallDirs(
  options: { root?: string; pid?: number; readStartedAt?: ProcessStartTimeReader } = {},
): Promise<CallDirs> {
  const root = options.root ?? BROWSER_TEMP_ROOT;
  const owner = await readCallOwner({ pid: options.pid, readStartedAt: options.readStartedAt });
  const dir = join(root, callDirName(owner));
  await mkdir(join(dir, "home"), { recursive: true });
  await mkdir(join(dir, "tmp"), { recursive: true });
  return { root: dir, home: join(dir, "home"), tmp: join(dir, "tmp") };
}
