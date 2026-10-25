export type SessionState =
  | { state: "setup_required" }
  | { state: "unauthenticated" }
  | { state: "authenticated"; expiresAt: number };

export type AuthErrorCode =
  | "invalid_pin"
  | "already_configured"
  | "setup_required"
  | "misconfigured"
  | "rate_limited"
  | "origin_mismatch"
  | "invalid_request";

export type AuthOutcome = { ok: true } | { ok: false; error: AuthErrorCode; retryAfterSeconds?: number };

/**
 * `hc` は validator を入れるまで POST body の型を共有できないため、auth の応答型はここで定義する。
 * 代わりに、応答の解釈をこの module に閉じ込めて画面側から JSON を触らせない。
 */
export async function fetchSession(): Promise<SessionState> {
  const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
  const body: unknown = await response.json();
  const state = readString(body, "state");

  if (state === "authenticated") {
    const expiresAt = readNumber(body, "expiresAt");

    if (expiresAt !== null) {
      return { state: "authenticated", expiresAt };
    }
  }

  return state === "setup_required" ? { state: "setup_required" } : { state: "unauthenticated" };
}

export async function submitPin(route: "/api/auth/setup" | "/api/auth/login", pin: string): Promise<AuthOutcome> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pin }),
  });

  if (response.ok) {
    return { ok: true };
  }

  const body: unknown = await response.json().catch(() => null);
  const error = readString(body, "error") as AuthErrorCode | null;
  const retryAfterSeconds = readNumber(body, "retryAfterSeconds") ?? undefined;

  return { ok: false, error: error ?? "misconfigured", retryAfterSeconds };
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "string" ? value : null;
}

function readNumber(body: unknown, key: string): number | null {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
