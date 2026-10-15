/**
 * 同時実行の入場制御。1 呼び出しは Chromium のプロセス群 (数百 MiB) を持つため、一時領域の隔離だけでは
 * 総資源の上限にならない。呼び出し側がブラウザを起動する前にここで入場を取る。
 *
 * 枠は `<root>/slots/<index>` のファイルで、`link` が原子的なので同じ index を取れるのは 1 つの呼び出し
 * だけになる。index は上限までしか無いので上限を超えて入場することはない。所有者は中身 (`<pid>-<起動時刻>`)
 * に置き、中身を読めない枠と上限の範囲外の枠は不明として容量を消費させる (fail-closed)。
 *
 * 終了済みと確認できた枠を引き継ぐときは、先に `<root>/retired/<index>-<所有者>` の記録を `link` で
 * 確保し、取れた呼び出しだけが枠を消して自分の枠に入れ替える。記録を取れるのは 1 つだけなので、古い
 * 所有者を読んだ後に遅れて再開した呼び出し (や同時に回収しようとした別の呼び出し) は記録を取れず、
 * 生存中の枠には触らない。記録は消さない (遅れて来た呼び出しを止める役目を負うため)。
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processStartedAtMs } from "../proc-stat";
import { MAX_CONCURRENT_CALLS } from "./limits";
import {
  BROWSER_TEMP_ROOT,
  callDirName,
  callOwnerState,
  claimFileName,
  parseCallDirName,
  readCallOwner,
  type CallOwner,
  type ProcessStartTimeReader,
} from "./temp";

/** 枠の置き場。呼び出しの一時領域 (`<root>/<pid>-<起動時刻>`) と同じ親の下に分けて置く */
export const SLOTS_DIR_NAME = "slots";

/** 終了済みの枠を引き継いだ記録の置き場。遅れて再開した呼び出しを止める役目のため消さない */
export const RETIRED_DIR_NAME = "retired";

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

/** 枠のファイル。名前は index だけで、所有者は中身に置く */
export function slotPath(dir: string, index: number): string {
  return join(dir, String(index));
}

/** 終了済みの枠を引き継いだ記録。index と世代 (所有者) ごとに 1 つで、内容ではなく存在が意味を持つ */
export function retirementPath(dir: string, index: number, retired: CallOwner): string {
  return join(dir, `${index}-${callDirName(retired)}`);
}

function parseSlotIndex(name: string): number | undefined {
  if (!/^[0-9]+$/.test(name)) return undefined;
  const index = Number(name);
  return Number.isSafeInteger(index) ? index : undefined;
}

/** 枠の所有者。中身を読めない (作成途中・破損) ときは不明として undefined を返す */
async function slotOwner(path: string): Promise<CallOwner | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseCallDirName(text.trim());
}

/** 名前が空いていれば作る。取れなければ false (他の呼び出しが先に取った) */
async function tryLink(source: string, path: string): Promise<boolean> {
  try {
    await link(source, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * 入場の範囲外にある枠 (上限より大きい index、index を持たない古い形式) が生きていれば true。
 * これらは index の数で上限を数える仕組みから見えないため、見つけたら入場しない (fail-closed)。
 */
async function hasLeaseOutsideRange(
  dir: string,
  limit: number,
  readStartedAt: ProcessStartTimeReader,
): Promise<boolean> {
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const index = parseSlotIndex(entry);
    if (index === undefined) {
      const legacy = parseCallDirName(entry);
      if (legacy && (await callOwnerState(legacy, readStartedAt)) !== "gone") return true;
      continue;
    }
    if (index < limit) continue;
    const owner = await slotOwner(slotPath(dir, index));
    if (!owner || (await callOwnerState(owner, readStartedAt)) !== "gone") return true;
  }
  return false;
}

/**
 * 終了済みと確認できた枠を引き継ぐ。記録 (retired/<index>-<世代>) の確保に勝った呼び出しだけが、
 * 枠を消して自分の枠に入れ替えられる。負けた呼び出しは枠に触らず undefined を返す。
 */
async function takeEndedSlot(options: {
  retiredDir: string;
  index: number;
  path: string;
  ended: CallOwner;
  staging: string;
}): Promise<string | undefined> {
  const record = retirementPath(options.retiredDir, options.index, options.ended);
  // 置き場は引き継ぎのときだけ作る (通常の入場では残骸を増やさない)
  await mkdir(options.retiredDir, { recursive: true });
  if (!(await tryLink(options.staging, record))) return undefined;
  // 記録がある間、この index の枠は誰も変えられない (持ち主は終了済みと確認済み)。消してから入れ替える
  await rm(options.path, { force: true });
  return (await tryLink(options.staging, options.path)) ? options.path : undefined;
}

/** 上限に達していたら ConcurrencyLimitError を投げる。取れた枠は呼び出しの終了時に release する */
export async function acquireConcurrencySlot(options: AcquireConcurrencySlotOptions = {}): Promise<ConcurrencySlot> {
  const root = options.root ?? BROWSER_TEMP_ROOT;
  const limit = options.limit ?? MAX_CONCURRENT_CALLS;
  const readStartedAt = options.readStartedAt ?? processStartedAtMs;
  const log = options.log ?? (() => {});
  const owner = await readCallOwner({ pid: options.pid, readStartedAt });
  const dir = join(root, SLOTS_DIR_NAME);
  const retiredDir = join(root, RETIRED_DIR_NAME);
  await mkdir(dir, { recursive: true });
  if (await hasLeaseOutsideRange(dir, limit, readStartedAt)) throw new ConcurrencyLimitError(limit);

  // 所有者を書いた一時ファイルを link することで、枠の名前が付いた時点で中身が確定する
  const staging = join(root, claimFileName(owner, randomUUID()));
  await writeFile(staging, `${callDirName(owner)}\n`);
  try {
    for (let index = 0; index < limit; index += 1) {
      const path = slotPath(dir, index);
      if (await tryLink(staging, path)) return admitted(dir, index, path);

      const current = await slotOwner(path);
      // 中身を読めない枠は不明として容量を消費させる (消しても安全か分からない)
      if (!current) continue;
      if ((await callOwnerState(current, readStartedAt)) !== "gone") continue;
      const taken = await takeEndedSlot({ retiredDir, index, path, ended: current, staging });
      if (taken) {
        log(`終了済みの呼び出しの枠 (index ${index}) を引き継ぎました`);
        return admitted(dir, index, taken);
      }
    }
    throw new ConcurrencyLimitError(limit);
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
}

/** 枠を解放する。消してよいのは自分が入れた枠だけ (他の呼び出しの枠には触らない) */
function admitted(dir: string, index: number, path: string): ConcurrencySlot {
  return {
    index,
    release: async () => {
      await rm(path, { force: true }).catch(() => undefined);
      await rmdir(dir).catch(() => undefined);
    },
  };
}
