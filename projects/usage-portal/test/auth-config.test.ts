// `PIN_HASH_B64` と `SESSION_SECRET` の検証条件を固定する。
import { describe, expect, test } from "bun:test";
import { loadAuthConfig } from "../src/server/auth-config";

const PIN_HASH = "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA";

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    PIN_HASH_B64: encode(PIN_HASH),
    SESSION_SECRET: encode(new Uint8Array(32).fill(7)),
    ...overrides,
  };
}

describe("loadAuthConfig", () => {
  test("base64url の PIN ハッシュと 32 bytes のセッション鍵を受け付ける", () => {
    const result = loadAuthConfig(env());

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.auth.pinHash).toBe(PIN_HASH);
      expect(result.auth.sessionSecret).toHaveLength(32);
    }
  });

  test("PIN_HASH_B64 が無ければ拒否する", () => {
    expect(loadAuthConfig(env({ PIN_HASH_B64: undefined })).ok).toBe(false);
  });

  test("$argon2id$ 以外の PIN ハッシュを拒否する", () => {
    const bcrypt = encode("$argon2i$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA");

    expect(loadAuthConfig(env({ PIN_HASH_B64: bcrypt })).ok).toBe(false);
  });

  test("base64url でない PIN_HASH_B64 を拒否する", () => {
    for (const value of ["not base64url", `${encode(PIN_HASH)}=`, "+/A", "A"]) {
      expect(loadAuthConfig(env({ PIN_HASH_B64: value })).ok).toBe(false);
    }
  });

  test("SESSION_SECRET が無ければ拒否する", () => {
    expect(loadAuthConfig(env({ SESSION_SECRET: undefined })).ok).toBe(false);
  });

  test("SESSION_SECRET が 32 bytes でなければ拒否する", () => {
    for (const size of [0, 16, 31, 33]) {
      const secret = size === 0 ? "" : encode(new Uint8Array(size).fill(1));

      expect(loadAuthConfig(env({ SESSION_SECRET: secret })).ok).toBe(false);
    }
  });

  test("base64url でない SESSION_SECRET を拒否する", () => {
    const secret = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");

    expect(loadAuthConfig(env({ SESSION_SECRET: secret })).ok).toBe(false);
  });
});
