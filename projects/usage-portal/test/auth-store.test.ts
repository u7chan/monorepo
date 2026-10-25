// PIN ハッシュとセッション鍵のファイル保存（場所・権限・排他）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSessionKey,
  isPinHashExistsError,
  readSessionKey,
  readStoredPinHash,
  writeStoredPinHash,
} from "../src/server/auth-store";

const dirs: string[] = [];
const PIN_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$NrpScq+UTuqIPUCxtFHszoYp1osij+WlDiEfSyjn2gE$j/HAXbjNIyy4j025wwx7lX0k7Da0uzAq3Xt7oppNvRg";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-auth-"));

  dirs.push(dir);

  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readStoredPinHash", () => {
  test("ファイルが無ければ absent、Argon2id 以外なら invalid", () => {
    const dir = tempDir();

    expect(readStoredPinHash(dir)).toEqual({ status: "absent" });

    writeFileSync(join(dir, "pin-hash"), "$argon2i$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA\n");

    expect(readStoredPinHash(dir)).toEqual({ status: "invalid" });

    // prefix が残った切り詰めも設定破損として扱う。
    writeFileSync(join(dir, "pin-hash"), "$argon2id$broken\n");

    expect(readStoredPinHash(dir)).toEqual({ status: "invalid" });
  });

  test("書き込んだハッシュを前後の空白を落として返す", () => {
    const dir = tempDir();

    writeStoredPinHash(dir, PIN_HASH);

    expect(readStoredPinHash(dir)).toEqual({ status: "ok", hash: PIN_HASH });
  });

  test("既存のハッシュは上書きせず、EEXIST として扱えるエラーを投げる", () => {
    const dir = tempDir();

    writeStoredPinHash(dir, PIN_HASH);

    let caught: unknown = null;

    try {
      writeStoredPinHash(
        dir,
        "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      );
    } catch (error) {
      caught = error;
    }

    expect(isPinHashExistsError(caught)).toBe(true);
    expect(readStoredPinHash(dir)).toEqual({ status: "ok", hash: PIN_HASH });
  });

  test("PIN ハッシュを 0600 で作る", () => {
    const dir = tempDir();

    writeStoredPinHash(dir, PIN_HASH);

    expect(mode(join(dir, "pin-hash"))).toBe(0o600);
  });
});

describe("ensureSessionKey", () => {
  test("32 bytes の鍵を 0600 で作り、2 回目以降は同じ鍵を返す", () => {
    const dir = tempDir();

    const key = ensureSessionKey(dir);

    expect(key).toHaveLength(32);
    expect(mode(join(dir, "session-key"))).toBe(0o600);
    expect(ensureSessionKey(dir)).toEqual(key);
    expect(readSessionKey(dir)).toEqual(key);
  });

  test("データディレクトリが無ければ 0700 で作る", () => {
    const base = tempDir();
    const dataDir = join(base, "nested", "data");

    ensureSessionKey(dataDir);

    expect(mode(dataDir)).toBe(0o700);
    expect(readSessionKey(dataDir)).toHaveLength(32);
  });

  test("鍵が無い / 長さが違うときは readSessionKey が null を返す", () => {
    const dir = tempDir();

    expect(readSessionKey(dir)).toBeNull();

    writeFileSync(join(dir, "session-key"), Buffer.alloc(10), { mode: 0o600 });

    expect(readSessionKey(dir)).toBeNull();
  });
});
