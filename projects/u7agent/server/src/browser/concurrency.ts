/**
 * 同時実行の入場制御。1 呼び出しは Chromium のプロセス群を持ち、一時領域の隔離は総資源の上限にはならないため、
 * 呼び出し側が起動前に入場を取る。1 プロセス内の counter では効かないので、置き場の下の `slots/` に
 * 自分の所有者名 (`<pid>-<startedAtMs>`) のファイルを作って数える。
 *
 * 競合の扱い: 枠は「自分が見た生存中の枠のうち、作成が早い順で上限まで」に入るときだけ取れる。自分の枠は
 * 一覧の前に作るので、先に作られた他人の枠は必ず自分の一覧に載る (載っていなければ相手が自分より後) — つまり
 * 上限を超えて同時に通ることはない。終了済みと確認できる枠だけを消す (名前が所有者を表すので、生きた枠を
 * 誤って消さない)。読めない枠は不明として残し、枠を塞いだままにする (fail-closed)。
 */
import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processStartedAtMs } from "../proc-stat";
import { MAX_CONCURRENT_CALLS } from "./limits";
import { callDirName, callOwnerState, parseCallDirName, BROWSER_TEMP_ROOT, type ProcessStartTimeReader } from "./temp";

/** 枠の置き場。呼び出しの一時領域 (`<root>/<pid>-<startedAtMs>`) と同じ親の下に分けて置く */
export const SLOTS_DIR_NAME = "slots";

export class ConcurrencyLimitError extends Error {
  constructor(limit: number) {
    super(`同時実行の上限 (${limit} 件) に達しています。実行中の呼び出しが終わるのを待って再実行してください`);
    this.name = "ConcurrencyLimitError";
  }
}

export interface ConcurrencySlot {
  /** 取れた枠の番号 (0 起点)。ログと診断用 */
  readonly index: number;
  release(): Promise<void>;
}

interface LiveSlot {
  owner: string;
  createdAtMs: number;
}

async function createdAtMs(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined);
  return info ? info.ctimeMs : Number.MAX_SAFE_INTEGER;
}

/** 終了済みと確認できる枠を消し、生存中 (不明を含む) の枠を返す */
async function liveSlots(
  dir: string,
  owner: string,
  readStartedAt: ProcessStartTimeReader,
  log: (message: string) => void,
): Promise<LiveSlot[]> {
  const live: LiveSlot[] = [];
  let reclaimed = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, entry);
    if (entry === owner) {
      live.push({ owner: entry, createdAtMs: await createdAtMs(path) });
      continue;
    }
    const parsed = parseCallDirName(entry);
    if (!parsed) continue;
    if ((await callOwnerState(parsed, readStartedAt)) !== "gone") {
      live.push({ owner: entry, createdAtMs: await createdAtMs(path) });
      continue;
    }
    await rm(path, { force: true });
    reclaimed += 1;
  }
  if (reclaimed > 0) log(`終了済みの呼び出しの同時実行枠を回収しました (${reclaimed} 件)`);
  // 作成順で並べ、同時刻は名前で決める (どのプロセスでも同じ順序になる)
  return live.sort((a, b) => a.createdAtMs - b.createdAtMs || a.owner.localeCompare(b.owner));
}

/** 上限に達していたら ConcurrencyLimitError を投げる。取れた枠は呼び出しの終了時に release する */
export async function acquireConcurrencySlot(
  options: {
    root?: string;
    limit?: number;
    pid?: number;
    readStartedAt?: ProcessStartTimeReader;
    log?: (message: string) => void;
  } = {},
): Promise<ConcurrencySlot> {
  const root = options.root ?? BROWSER_TEMP_ROOT;
  const limit = options.limit ?? MAX_CONCURRENT_CALLS;
  const pid = options.pid ?? process.pid;
  const readStartedAt = options.readStartedAt ?? processStartedAtMs;
  const log = options.log ?? (() => {});
  let startedAtMs: number | undefined;
  try {
    startedAtMs = await readStartedAt(pid);
  } catch (error) {
    throw new Error(`プロセス ${pid} の起動時刻を /proc から読めません: ${(error as Error).message}`);
  }
  if (!startedAtMs) throw new Error(`プロセス ${pid} の起動時刻を /proc から読めません`);

  const owner = callDirName({ pid, startedAtMs });
  const dir = join(root, SLOTS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const release = async (): Promise<void> => {
    await rm(join(dir, owner), { force: true }).catch(() => undefined);
    await rmdir(dir).catch(() => undefined);
  };
  try {
    await writeFile(join(dir, owner), `${owner}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const index = (await liveSlots(dir, owner, readStartedAt, log)).findIndex((slot) => slot.owner === owner);
  if (index < 0 || index >= limit) {
    await release();
    throw new ConcurrencyLimitError(limit);
  }
  return { index, release };
}
