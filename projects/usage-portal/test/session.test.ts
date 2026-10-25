// 署名付きセッション cookie の形式・改ざん検出・期限を固定する。
import { describe, expect, test } from "bun:test";
import {
  clearSessionCookie,
  createSessionToken,
  readCookie,
  readSessionToken,
  sessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "../src/server/session";

const key = new Uint8Array(32).fill(3);
const pinHash =
  "$argon2id$v=19$m=65536,t=2,p=1$NrpScq+UTuqIPUCxtFHszoYp1osij+WlDiEfSyjn2gE$j/HAXbjNIyy4j025wwx7lX0k7Da0uzAq3Xt7oppNvRg";
const now = 1_800_000_000_000;

describe("createSessionToken / readSessionToken", () => {
  test("発行した token を読み戻せる", () => {
    const token = createSessionToken({ key, pinHash, now });
    const session = readSessionToken(token, { key, pinHash, now });

    expect(token.startsWith("v1.")).toBe(true);
    expect(session).toEqual({ expiresAt: now + SESSION_TTL_SECONDS * 1000 });
  });

  test("期限を過ぎた token は通さない", () => {
    const token = createSessionToken({ key, pinHash, now });
    const later = now + SESSION_TTL_SECONDS * 1000 + 1;

    expect(readSessionToken(token, { key, pinHash, now: later })).toBeNull();
  });

  test("payload を書き換えた token は通さない", () => {
    const token = createSessionToken({ key, pinHash, now });
    const [version, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, iat: now, exp: now + 10 * SESSION_TTL_SECONDS * 1000 }),
      "utf8",
    ).toString("base64url");

    expect(readSessionToken(`${version}.${forged}.${signature}`, { key, pinHash, now })).toBeNull();
  });

  test("PIN ハッシュか鍵が変わった token は通さない", () => {
    const token = createSessionToken({ key, pinHash, now });

    expect(readSessionToken(token, { key, pinHash: "$argon2id$other", now })).toBeNull();
    expect(readSessionToken(token, { key: new Uint8Array(32).fill(4), pinHash, now })).toBeNull();
  });

  test("形式が違う token は通さない", () => {
    for (const token of ["", "v1", "v2.abc.def", "v1.abc", "v1.."]) {
      expect(readSessionToken(token, { key, pinHash, now })).toBeNull();
    }
  });
});

describe("cookie", () => {
  test("HttpOnly / SameSite=Lax / Max-Age 30 日を付ける", () => {
    const cookie = sessionCookie("v1.payload.signature");

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=v1.payload.signature`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(cookie).not.toContain("Secure");
  });

  test("削除用 cookie は Max-Age=0 で値を空にする", () => {
    expect(clearSessionCookie()).toBe(`${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  });

  test("Cookie ヘッダーから対象の値だけを取り出す", () => {
    const header = `other=1; ${SESSION_COOKIE_NAME}=v1.payload.signature; trailing=2`;

    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe("v1.payload.signature");
    expect(readCookie(header, "missing")).toBeNull();
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeNull();
  });
});
