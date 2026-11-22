import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isArgon2idHash } from "./pin";

const PIN_HASH_FILE = "pin-hash";
const SESSION_KEY_FILE = "session-key";
const SESSION_KEY_BYTES = 32;

export type StoredPinHash = { status: "absent" } | { status: "ok"; hash: string } | { status: "invalid" };

export function readStoredPinHash(dataDir: string): StoredPinHash {
  let raw: string;

  try {
    raw = readFileSync(join(dataDir, PIN_HASH_FILE), "utf8");
  } catch (error) {
    return isErrno(error, "ENOENT") ? { status: "absent" } : { status: "invalid" };
  }

  const hash = raw.trim();

  return isArgon2idHash(hash) ? { status: "ok", hash } : { status: "invalid" };
}

export function writeStoredPinHash(dataDir: string, hash: string): void {
  ensureDataDir(dataDir);
  // `wx` で既存を上書きしない。同時セットアップは後勝ちにせず、負けた側を失敗させる。
  writeFileSync(join(dataDir, PIN_HASH_FILE), `${hash}\n`, { mode: 0o600, flag: "wx" });
}

export function isPinHashExistsError(error: unknown): boolean {
  return isErrno(error, "EEXIST");
}

export function readSessionKey(dataDir: string): Uint8Array | null {
  let raw: Buffer;

  try {
    raw = readFileSync(join(dataDir, SESSION_KEY_FILE));
  } catch {
    return null;
  }

  return raw.length === SESSION_KEY_BYTES ? new Uint8Array(raw) : null;
}

export function ensureSessionKey(dataDir: string): Uint8Array {
  const existing = readSessionKey(dataDir);

  if (existing) {
    return existing;
  }

  const key = randomBytes(SESSION_KEY_BYTES);

  ensureDataDir(dataDir);

  try {
    writeFileSync(join(dataDir, SESSION_KEY_FILE), key, { mode: 0o600, flag: "wx" });

    return new Uint8Array(key);
  } catch (error) {
    // 同時起動で先に作られた場合は、勝った側の鍵を使う。
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }

    const raced = readSessionKey(dataDir);

    if (!raced) {
      throw new Error("セッション鍵を読み出せません");
    }

    return raced;
  }
}

function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
