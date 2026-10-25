export type AuthConfig = {
  pinHash: string;
  sessionSecret: Uint8Array;
};

export type AuthConfigResult = { ok: true; auth: AuthConfig } | { ok: false };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PIN_HASH_PREFIX = "$argon2id$";
const SESSION_SECRET_BYTES = 32;

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfigResult {
  const pinHash = decodePinHash(env.PIN_HASH_B64);
  const sessionSecret = decodeSessionSecret(env.SESSION_SECRET);

  if (pinHash === null || sessionSecret === null) {
    return { ok: false };
  }

  return { ok: true, auth: { pinHash, sessionSecret } };
}

function decodePinHash(value: string | undefined): string | null {
  const decoded = decodeBase64Url(value);

  if (decoded === null) {
    return null;
  }

  const pinHash = new TextDecoder().decode(decoded);

  return pinHash.startsWith(PIN_HASH_PREFIX) ? pinHash : null;
}

function decodeSessionSecret(value: string | undefined): Uint8Array | null {
  const decoded = decodeBase64Url(value);

  return decoded?.length === SESSION_SECRET_BYTES ? decoded : null;
}

function decodeBase64Url(value: string | undefined): Uint8Array | null {
  const raw = value?.trim() ?? "";

  // Buffer.from の base64url は不正文字と桁あふれを黙って捨てるため、設定値の誤りを検出できない。
  if (raw === "" || !BASE64URL.test(raw) || raw.length % 4 === 1) {
    return null;
  }

  return new Uint8Array(Buffer.from(raw, "base64url"));
}
