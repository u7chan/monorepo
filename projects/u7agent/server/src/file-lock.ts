/**
 * 起動ごとのロックファイル。flock はプロセスの終了でカーネルが外すので、pid の再利用や ppid に依らず、
 * 「起動元がまだ生きている」ことを確かめられる。FFI を使えない環境では確かめられないので unknown にする。
 */
import { closeSync, openSync } from "node:fs";
import { loadLibc } from "./libc";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 11;

export interface FileLock {
  release(): void;
}

/** 起動元が持つロックを取る。取れなければ undefined (呼び出し側は起動しない) */
export async function acquireFileLock(path: string): Promise<FileLock | undefined> {
  let fd: number;
  try {
    fd = openSync(path, "w", 0o600);
  } catch {
    return undefined;
  }
  const lib = await loadLibc();
  if (!lib || lib.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    return undefined;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        lib.flock(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** ロックを持っているプロセスが居るか。ファイルが無い・読めないときは unknown (送らない側へ倒す) */
export async function fileLockHeld(path: string): Promise<"held" | "free" | "unknown"> {
  const lib = await loadLibc();
  if (!lib) return "unknown";
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "unknown";
  }
  try {
    if (lib.flock(fd, LOCK_EX | LOCK_NB) === 0) {
      lib.flock(fd, LOCK_UN);
      return "free";
    }
    return lib.errno() === EWOULDBLOCK ? "held" : "unknown";
  } finally {
    closeSync(fd);
  }
}
