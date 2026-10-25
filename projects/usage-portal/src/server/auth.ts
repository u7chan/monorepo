import {
  ensureSessionKey,
  isPinHashExistsError,
  readSessionKey,
  readStoredPinHash,
  writeStoredPinHash,
} from "./auth-store";
import { hashPin, isValidPin, verifyPin } from "./pin";
import { createSessionToken, readCookie, readSessionToken, SESSION_COOKIE_NAME } from "./session";

export type AuthStatus = "ok" | "setup_required" | "misconfigured";

export type AuthFailureReason = "invalid_pin" | "already_configured" | "setup_required" | "misconfigured";

export type AuthResult = { ok: true; token: string } | { ok: false; reason: AuthFailureReason };

export type AuthService = {
  status: () => AuthStatus;
  ensureSessionKey: () => void;
  setup: (pin: string) => Promise<AuthResult>;
  login: (pin: string) => Promise<AuthResult>;
  readSession: (cookieHeader: string | null) => { expiresAt: number } | null;
};

export function createAuthService(options: { dataDir: string; now?: () => number }): AuthService {
  const { dataDir } = options;
  const now = options.now ?? Date.now;

  return {
    // 読み取りだけ。鍵が無い状態は setup で作れるので、PIN 未設定なら setup_required を優先する。
    status() {
      const stored = readStoredPinHash(dataDir);

      if (stored.status === "invalid") {
        return "misconfigured";
      }

      if (stored.status === "absent") {
        return "setup_required";
      }

      return readSessionKey(dataDir) ? "ok" : "misconfigured";
    },
    ensureSessionKey() {
      ensureSessionKey(dataDir);
    },
    async setup(pin) {
      const stored = readStoredPinHash(dataDir);

      if (stored.status === "invalid") {
        return { ok: false, reason: "misconfigured" };
      }

      if (stored.status === "ok") {
        return { ok: false, reason: "already_configured" };
      }

      if (!isValidPin(pin)) {
        return { ok: false, reason: "invalid_pin" };
      }

      const hash = await hashPin(pin);

      try {
        writeStoredPinHash(dataDir, hash);
      } catch (error) {
        if (isPinHashExistsError(error)) {
          return { ok: false, reason: "already_configured" };
        }

        return { ok: false, reason: "misconfigured" };
      }

      let key: Uint8Array;

      try {
        key = ensureSessionKey(dataDir);
      } catch {
        return { ok: false, reason: "misconfigured" };
      }

      return { ok: true, token: createSessionToken({ key, pinHash: hash, now: now() }) };
    },
    async login(pin) {
      const stored = readStoredPinHash(dataDir);

      if (stored.status === "absent") {
        return { ok: false, reason: "setup_required" };
      }

      if (stored.status === "invalid") {
        return { ok: false, reason: "misconfigured" };
      }

      if (!isValidPin(pin) || !(await verifyPin(pin, stored.hash))) {
        return { ok: false, reason: "invalid_pin" };
      }

      const key = readSessionKey(dataDir);

      if (!key) {
        return { ok: false, reason: "misconfigured" };
      }

      return { ok: true, token: createSessionToken({ key, pinHash: stored.hash, now: now() }) };
    },
    readSession(cookieHeader) {
      const stored = readStoredPinHash(dataDir);
      const key = readSessionKey(dataDir);
      const token = readCookie(cookieHeader, SESSION_COOKIE_NAME);

      if (stored.status !== "ok" || !key || !token) {
        return null;
      }

      return readSessionToken(token, { key, pinHash: stored.hash, now: now() });
    },
  };
}
