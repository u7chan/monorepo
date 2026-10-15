/**
 * 同時実行の入場制御。1 呼び出しは Chromium のプロセス群 (数百 MiB) を持つため、一時領域の隔離だけでは
 * 総資源の上限にならない。呼び出し側がブラウザを起動する前にここで入場を取る。
 *
 * 枠は `<root>/slots/<index>/<pid>-<起動時刻>` のファイルで、名前が所有者 (世代) を表す。index の
 * ディレクトリ (`mkdir`) とファイルの作成 (`O_EXCL`) が原子的なので、同じ index を取れるのは 1 つの
 * 呼び出しだけになり、index は上限までしか無いので上限を超えて入場することはない。
 *
 * 終了済みの枠を引き継ぐときは、観測した世代のファイルを `rename` で自分の世代名へ移す。壊す対象が
 * 「観測した世代の名前」で条件付けられるので、古い所有者を読んだ後に遅れて再開した呼び出しが触れるのは
 * 自分の観測した世代だけになり、生存中の枠 (別の世代) は消えない。世代名は (pid, 起動時刻) で一意なので、
 * 同じ名前が生きた呼び出しの枠として現れることはない。
 *
 * 中断の回復: どの段階で SIGKILL されても容量は減らない。空のまま残った index ディレクトリは、空のとき
 * だけ成功する `rmdir` で回収でき、終了済み所有者の枠はそのまま残るので次の呼び出しが引き継ぐ。中身の
 * 分からないディレクトリ (複数の枠・所有者名でない名前) は消さずに容量として扱う (fail-closed)。
 */
import { mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { processStartedAtMs } from "../proc-stat";
import { MAX_CONCURRENT_CALLS } from "./limits";
import {
  BROWSER_TEMP_ROOT,
  callDirName,
  callOwnerState,
  parseCallDirName,
  readCallOwner,
  type CallOwner,
  type ProcessStartTimeReader,
} from "./temp";

/** 枠の置き場。呼び出しの一時領域 (`<root>/<pid>-<起動時刻>`) と同じ親の下に分けて置く */
export const SLOTS_DIR_NAME = "slots";

// 一意性確認に敗れて自分の枠を外した後の取り直しは「空の index の回収 → 作り直し → 枠の作成」に
// 2 回を使うので、2 回では空き枠を取り逃す。生存中の枠を見たら即座に諦めるため、待ちは生じない。
const CLAIM_ATTEMPTS = 4;

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

export interface AcquireConcurrencySlotOptions {
  root?: string;
  limit?: number;
  pid?: number;
  readStartedAt?: ProcessStartTimeReader;
  log?: (message: string) => void;
}

/** index のディレクトリ。この下に 1 つだけ枠のファイルを置く */
export function slotDirPath(dir: string, index: number): string {
  return join(dir, String(index));
}

/** 枠のファイル。名前が所有者 (世代) を表し、中身は使わない */
export function leasePath(dir: string, index: number, owner: CallOwner): string {
  return join(slotDirPath(dir, index), callDirName(owner));
}

function parseSlotIndex(name: string): number | undefined {
  if (!/^[0-9]+$/.test(name)) return undefined;
  const index = Number(name);
  return Number.isSafeInteger(index) ? index : undefined;
}

/** 空いていれば作る。取れなければ false (他の呼び出しが先に取った) */
async function tryMkdir(path: string): Promise<boolean> {
  try {
    await mkdir(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * index ディレクトリの中身。消えていた (ENOENT) ときは空として扱う (誰も持っていない空の index と同じ)。
 * ディレクトリでなければ (旧形式のファイルなど) undefined。
 */
async function readIndexDir(dirPath: string): Promise<string[] | undefined> {
  return readdir(dirPath).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : undefined));
}

/** 旧形式 (index の位置のファイル) が名乗る所有者。読めない・形が違うときは undefined */
async function readLegacyOwner(path: string): Promise<CallOwner | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseCallDirName(text.trim());
}

async function isLive(owner: CallOwner | undefined, readStartedAt: ProcessStartTimeReader): Promise<boolean> {
  return owner !== undefined && (await callOwnerState(owner, readStartedAt)) !== "gone";
}

/**
 * index のディレクトリに自分の枠を入れる。空のディレクトリを回収した別の呼び出しが同じ index を
 * 作り直していた場合は、枠が 2 つになるので自分の枠を外して譲る (確認できるまで入場しない)。
 */
async function installLease(dirPath: string, owner: CallOwner): Promise<string | undefined> {
  const path = join(dirPath, callDirName(owner));
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST: 同じ世代で既に入っている (同じプロセスの同時取得)。ENOENT: ディレクトリが回収された
    if (code === "EEXIST" || code === "ENOENT") return undefined;
    throw error;
  }
  await handle.close().catch(() => undefined);
  const entries = await readIndexDir(dirPath);
  if (!entries || entries.length !== 1 || entries[0] !== callDirName(owner)) {
    await rm(path, { force: true }).catch(() => undefined);
    return undefined;
  }
  return path;
}

/**
 * 1 つの index を取る。取れなければ undefined を返す。空のディレクトリ (中断の残り) の回収と、
 * 終了済みの枠の引き継ぎは、名前で条件付けられた操作だけで行う。
 */
async function claimIndex(options: {
  dir: string;
  index: number;
  owner: CallOwner;
  readStartedAt: ProcessStartTimeReader;
}): Promise<string | undefined> {
  const dirPath = slotDirPath(options.dir, options.index);
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    if (await tryMkdir(dirPath)) {
      const installed = await installLease(dirPath, options.owner);
      if (installed) return installed;
      continue; // ディレクトリを回収された / 一意性確認に敗れた場合は、空に戻った index を取り直す
    }
    const entries = await readIndexDir(dirPath);
    if (entries === undefined) {
      // index の位置にファイルがある (この仕組みより前の置き場)。終了済みと確認できたときだけ消す
      const legacy = await readLegacyOwner(dirPath);
      if (!legacy || (await callOwnerState(legacy, options.readStartedAt)) !== "gone") return undefined;
      await rm(dirPath, { force: true }).catch(() => undefined);
      continue;
    }
    if (entries.length === 0) {
      // 枠を入れる前に中断した残り。空のときだけ消せるので、消せたら書き直す
      await rmdir(dirPath).catch(() => undefined);
      continue;
    }
    const owners = entries.map((entry) => parseCallDirName(entry));
    if (owners.some((entry) => entry === undefined)) return undefined;
    for (const ended of owners) {
      // 生きている・分からない所有者が 1 つでもあれば、この index は容量として扱う
      if (await isLive(ended, options.readStartedAt)) return undefined;
    }
    // 終了済みの世代だけのディレクトリ。1 つを自分の世代名へ移して引き継ぐ (消す対象は世代名で決まる)
    const ended = owners[0] as CallOwner;
    const path = leasePath(options.dir, options.index, options.owner);
    const moved = await rename(join(dirPath, callDirName(ended)), path).then(
      () => true,
      () => false,
    );
    if (!moved) return undefined; // 既に引き継がれた (ENOENT) ／ ディレクトリが入れ替わった
    const after = await readIndexDir(dirPath);
    if (after && after.length === 1 && after[0] === callDirName(options.owner)) return path;
    // 終了済みの枠が残っている (枠が 2 つ以上あった)。自分の枠を外して次の機会に 1 つずつ減らす
    await rm(path, { force: true }).catch(() => undefined);
  }
  return undefined;
}

/**
 * index の範囲外の枠が生きていれば true。index の数で上限を数える仕組みから見えないため、
 * 見つけたら入場しない (数えられない分を容量として扱う)。index を持たない名前も同じ扱いにする。
 */
async function hasUncountableLease(
  dir: string,
  limit: number,
  readStartedAt: ProcessStartTimeReader,
): Promise<boolean> {
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const index = parseSlotIndex(entry);
    if (index === undefined) {
      if (await isLive(parseCallDirName(entry), readStartedAt)) return true;
      continue;
    }
    if (index < limit) continue;
    const dirPath = slotDirPath(dir, index);
    const entries = await readIndexDir(dirPath);
    if (entries === undefined) {
      if (await isLive(await readLegacyOwner(dirPath), readStartedAt)) return true;
      continue;
    }
    if (entries.length === 0) continue;
    if (entries.length !== 1) return true; // 分からない形は消さずに容量として扱う
    if (await isLive(parseCallDirName(entries[0] as string), readStartedAt)) return true;
  }
  return false;
}

/** 上限に達していたら ConcurrencyLimitError を投げる。取れた枠は呼び出しの終了時に release する */
export async function acquireConcurrencySlot(options: AcquireConcurrencySlotOptions = {}): Promise<ConcurrencySlot> {
  const root = options.root ?? BROWSER_TEMP_ROOT;
  const limit = options.limit ?? MAX_CONCURRENT_CALLS;
  const readStartedAt = options.readStartedAt ?? processStartedAtMs;
  const log = options.log ?? (() => {});
  const owner = await readCallOwner({ pid: options.pid, readStartedAt });
  const dir = join(root, SLOTS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  if (await hasUncountableLease(dir, limit, readStartedAt)) throw new ConcurrencyLimitError(limit);
  for (let index = 0; index < limit; index += 1) {
    const path = await claimIndex({ dir, index, owner, readStartedAt });
    if (path) {
      log(`同時実行の枠 (index ${index}) を取りました`);
      return admitted(dir, index, path);
    }
  }
  throw new ConcurrencyLimitError(limit);
}

/** 枠を解放する。消してよいのは自分が入れた枠だけ (他の呼び出しの枠には触らない) */
function admitted(dir: string, index: number, path: string): ConcurrencySlot {
  return {
    index,
    release: async () => {
      await rm(path, { force: true }).catch(() => undefined);
      await rmdir(slotDirPath(dir, index)).catch(() => undefined);
      await rmdir(dir).catch(() => undefined);
    },
  };
}
