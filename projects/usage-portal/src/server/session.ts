import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "usage_portal_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const SESSION_VERSION = 1;
const MAC_CONTEXT = "usage-portal-session:";
const TOKEN_PATTERN = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export type SessionPayload = {
  expiresAt: number;
};

export function createSessionToken(options: { key: Uint8Array; pinHash: string; now: number }): string {
  const expiresAt = options.now + SESSION_TTL_SECONDS * 1000;
  const payload = Buffer.from(
    JSON.stringify({ v: SESSION_VERSION, iat: options.now, exp: expiresAt }),
    "utf8",
  ).toString("base64url");

  return `v${SESSION_VERSION}.${payload}.${sign(options.key, options.pinHash, payload)}`;
}

export function readSessionToken(
  token: string,
  options: { key: Uint8Array; pinHash: string; now: number },
): SessionPayload | null {
  const match = TOKEN_PATTERN.exec(token);

  if (!match || match[1] !== String(SESSION_VERSION)) {
    return null;
  }

  const payload = match[2] ?? "";
  const signature = match[3] ?? "";
  const expected = Buffer.from(sign(options.key, options.pinHash, payload), "base64url");
  const actual = Buffer.from(signature, "base64url");

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  const parsed = parsePayload(payload);

  return parsed && parsed.exp > options.now ? { expiresAt: parsed.exp } : null;
}

export function sessionCookie(token: string): string {
  // v1 は HTTP で LAN 内にだけ出すため `Secure` を付けない。TLS 終端を置くときに足す。
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }

  return null;
}

function sign(key: Uint8Array, pinHash: string, payload: string): string {
  // payload も署名対象にする。署名鍵に PIN ハッシュを混ぜるのは、PIN 変更で既存 cookie を無効にするため。
  return createHmac("sha256", key).update(`${MAC_CONTEXT}${pinHash}.${payload}`).digest("base64url");
}

function parsePayload(payload: string): { exp: number } | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const { v, exp } = parsed as { v?: unknown; exp?: unknown };

  if (v !== SESSION_VERSION || typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }

  return { exp };
}
