/**
 * 起動ごとのロックファイル。flock はプロセスの終了でカーネルが外すので、pid の再利用や ppid に依らず、
 * 「起動元がまだ生きている」ことを確かめられる。FFI を使えない環境では確かめられないので unknown にする。
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { loadLibc } from "./libc";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 11;

export interface FileLock {
  release(): Promise<void>;
}

/** 通常ファイルだけを開く。FIFO や symlink を掴んで待たされないよう、種類は開いたあとに確かめる */
async function openLockFile(path: string, flags: number): Promise<FileHandle | undefined> {
  let file: FileHandle;
  try {
    file = await open(path, flags | constants.O_NOFOLLOW, 0o600);
  } catch {
    return undefined;
  }
  try {
    if ((await file.stat()).isFile()) return file;
  } catch {
    // 種類を読めないものは使わない
  }
  await file.close().catch(() => {});
  return undefined;
}

/** 起動元が持つロックを取る。取れなければ undefined (呼び出し側は起動しない) */
export async function acquireFileLock(path: string): Promise<FileLock | undefined> {
  const file = await openLockFile(path, constants.O_RDWR | constants.O_CREAT);
  if (!file) return undefined;
  const lib = await loadLibc();
  if (!lib || lib.flock(file.fd, LOCK_EX | LOCK_NB) !== 0) {
    await file.close().catch(() => {});
    return undefined;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        lib.flock(file.fd, LOCK_UN);
      } finally {
        await file.close().catch(() => {});
      }
    },
  };
}

/** ロックを持っているプロセスが居るか。ファイルが無い・読めないときは unknown (送らない側へ倒す) */
export async function fileLockHeld(path: string): Promise<"held" | "free" | "unknown"> {
  const lib = await loadLibc();
  if (!lib) return "unknown";
  // NFS の排他ロックは書き込み可能な fd を要求するので、観測も取得と同じモードで開く
  const file = await openLockFile(path, constants.O_RDWR);
  if (!file) return "unknown";
  try {
    if (lib.flock(file.fd, LOCK_EX | LOCK_NB) === 0) {
      lib.flock(file.fd, LOCK_UN);
      return "free";
    }
    return lib.errno() === EWOULDBLOCK ? "held" : "unknown";
  } finally {
    await file.close().catch(() => {});
  }
}
