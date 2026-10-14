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

/** 起動時刻の読み取り。undefined = 終了済み、0 = 不明 (生存として扱う) */
export type ProcessStartTimeReader = (pid: number) => Promise<number | undefined>;

export function callDirName(owner: CallOwner): string {
  return `${owner.pid}-${owner.startedAtMs}`;
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
 * 生存と確認できるか。起動時刻が読めない (0) ときは生存として扱い消さない側へ倒す。
 * 起動時刻が一致しない場合は PID が再利用された (元の所有者は終了した) と判定する。
 */
export async function isCallOwnerAlive(
  owner: CallOwner,
  readStartedAt: ProcessStartTimeReader = processStartedAtMs,
): Promise<boolean> {
  const current = await readStartedAt(owner.pid);
  if (current === undefined) return false;
  if (current === 0) return true;
  return current === owner.startedAtMs;
}

/** 終了済みと確認できる呼び出しの置き場だけを消す。失敗は警告に留め、呼び出し元は続行する */
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
    const owner = parseCallDirName(entry);
    if (!owner) continue;
    try {
      if (await isCallOwnerAlive(owner, readStartedAt)) continue;
    } catch (error) {
      log(`所有者を確認できないため残します (${entry}): ${(error as Error).message}`);
      continue;
    }
    try {
      await rm(join(root, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch (error) {
      log(`古い一時領域を削除できませんでした (${entry}): ${(error as Error).message}`);
    }
  }
  return removed;
}

/** 自分の呼び出し用の領域を作る。名前は自分の pid と起動時刻で、他の呼び出しの掃除から生存と判定される */
export async function createCallDirs(
  options: { root?: string; pid?: number; readStartedAt?: ProcessStartTimeReader } = {},
): Promise<CallDirs> {
  const root = options.root ?? BROWSER_TEMP_ROOT;
  const pid = options.pid ?? process.pid;
  const readStartedAt = options.readStartedAt ?? processStartedAtMs;
  const startedAtMs = await readStartedAt(pid);
  if (!startedAtMs) throw new Error(`プロセス ${pid} の起動時刻を /proc から読めません`);
  const dir = join(root, callDirName({ pid, startedAtMs }));
  await mkdir(join(dir, "home"), { recursive: true });
  await mkdir(join(dir, "tmp"), { recursive: true });
  return { root: dir, home: join(dir, "home"), tmp: join(dir, "tmp") };
}
