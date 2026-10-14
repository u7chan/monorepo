/**
 * 同時実行の入場制御。1 呼び出しは Chromium のプロセス群 (数百 MiB) を持つため、一時領域の隔離だけでは
 * 総資源の上限にならない。呼び出し側がブラウザを起動する前にここで入場を取る。
 *
 * 枠は `<root>/slots/<index>` のファイルで、`link` が原子的なので同じ index を取れるのは 1 つの
 * 呼び出しだけになる。index は上限までしか無いので、上限を超えて入場することも、後から来た呼び出しが
 * 入場済みの枠を押し出すこともない (時刻や名前の並び順を入場の根拠にしない)。終了済みと確認できる枠
 * だけを消して index を空け、読めない枠は不明として塞いだままにする (fail-closed)。
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
  parseCallDirName,
  readCallOwner,
  type CallOwner,
  type ProcessStartTimeReader,
} from "./temp";

/** 枠の置き場。呼び出しの一時領域 (`<root>/<pid>-<起動時刻>`) と同じ親の下に分けて置く */
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

/**
 * 1 つの index を確保する。内容を持つ一時ファイルを作って `link` する: 作成と書き込みを分けると、
 * その間だけ所有者の分からない枠が残り、その index を塞いだままにし得るため。
 * 取れなければ (同じ index を同時に狙った相手が先に確保した) undefined を返す。
 */
async function claimIndex(dir: string, index: number, owner: CallOwner): Promise<string | undefined> {
  const path = slotPath(dir, index);
  const staging = join(dir, `.claim-${randomUUID()}`);
  try {
    await writeFile(staging, `${callDirName(owner)}\n`);
    await link(staging, path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
}

/**
 * 入場済みの index と、上限より大きい index の枠を集める。後者はより大きい上限で入場した呼び出しの
 * 印なので、数えられない分を容量として扱う (数えられない枠を見逃すと上限を超えて入場し得る)。
 */
async function occupiedSlots(
  dir: string,
  limit: number,
  readStartedAt: ProcessStartTimeReader,
  log: (message: string) => void,
): Promise<{ indexes: Set<number>; overLimit: boolean }> {
  const indexes = new Set<number>();
  let overLimit = false;
  let reclaimed = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const index = parseSlotIndex(entry);
    if (index === undefined) {
      // index を持たない形式 (この上限を導入する前の枠) は数えられないので、生きている間は入場しない
      const legacy = parseCallDirName(entry);
      if (!legacy) continue;
      if ((await callOwnerState(legacy, readStartedAt)) === "gone") {
        await rm(join(dir, entry), { force: true });
        reclaimed += 1;
        continue;
      }
      overLimit = true;
      continue;
    }
    const owner = await slotOwner(slotPath(dir, index));
    if (owner && (await callOwnerState(owner, readStartedAt)) === "gone") {
      await rm(slotPath(dir, index), { force: true });
      reclaimed += 1;
      continue;
    }
    indexes.add(index);
    if (index >= limit) overLimit = true;
  }
  if (reclaimed > 0) log(`終了済みの呼び出しの同時実行枠を回収しました (${reclaimed} 件)`);
  return { indexes, overLimit };
}

/** 上限に達していたら ConcurrencyLimitError を投げる。取れた枠は呼び出しの終了時に release する */
export async function acquireConcurrencySlot(options: AcquireConcurrencySlotOptions = {}): Promise<ConcurrencySlot> {
  const root = options.root ?? BROWSER_TEMP_ROOT;
  const limit = options.limit ?? MAX_CONCURRENT_CALLS;
  const pid = options.pid ?? process.pid;
  const readStartedAt = options.readStartedAt ?? processStartedAtMs;
  const log = options.log ?? (() => {});
  const owner = await readCallOwner({ pid, readStartedAt });
  const dir = join(root, SLOTS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const occupied = await occupiedSlots(dir, limit, readStartedAt, log);
  if (occupied.overLimit) throw new ConcurrencyLimitError(limit);
  for (let index = 0; index < limit; index += 1) {
    if (occupied.indexes.has(index)) continue;
    const path = await claimIndex(dir, index, owner);
    if (!path) continue;
    return {
      index,
      release: async () => {
        await rm(path, { force: true }).catch(() => undefined);
        await rmdir(dir).catch(() => undefined);
      },
    };
  }
  throw new ConcurrencyLimitError(limit);
}
