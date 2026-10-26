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

export type UsageWindow = {
  id: string;
  label: string;
  durationSeconds: number | null;
  usedPercent: number;
  resetsAt: number | null;
};

export type Trend = { windowId: string; spanMs: number; points: { at: number; usedPercent: number }[] };

export type ProviderId = "codex" | "opencode-go";
export type ProviderState = "loading" | "ok" | "stale" | "error";

/** 画面のヘッダーに出すアカウントの識別情報。キーは受け取らない。 */
export type UsageSourceAccount = { id: string; name: string; icon: string };

export type UsageSource = {
  /** `codex` または account の uuid。 */
  id: string;
  provider: ProviderId;
  name: string;
  plan: string | null;
  account: UsageSourceAccount | null;
  state: ProviderState;
  capturedAt: number | null;
  error: { code: string; message: string; at: number } | null;
  limitReached: boolean;
  windows: UsageWindow[];
  notes: string[];
  /** 窓ごとの推移。2 点未満の窓は含まれない。 */
  trends: Trend[];
};

export type UsagePayload = { generatedAt: number; sampleIntervalMs: number; sources: UsageSource[] };

export type CodexLoginOption = { id: string; label: string };

export type CodexLoginPrompt =
  | { type: "select"; message: string; options: CodexLoginOption[] }
  | { type: "manual_code"; message: string; placeholder: string | null };

export type CodexLoginState = {
  status: "running" | "succeeded" | "failed" | "cancelled";
  instructions: string | null;
  progress: string | null;
  authUrl: string | null;
  userCode: string | null;
  prompt: CodexLoginPrompt | null;
  error: string | null;
};

export type CodexAuthState = { signedIn: boolean; login: CodexLoginState | null };

export type OpenCodeAccount = { id: string; name: string; icon: string; savedAt: number };

export type OpenCodeAccountInput = { name: string; icon: string; apiKey: string };

export type OpenCodeAccountPatch = { name?: string; icon?: string; apiKey?: string };

export type OpenCodeAccountOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export type CodexLoginOutcome = { ok: true; state: CodexAuthState } | { ok: false; error: string };

/** 認証切れは画面をログインへ戻す合図。通信失敗は `null` として区別する。 */
export type Unauthorized = { unauthorized: true };

/**
 * `hc` は validator を入れるまで POST body の型を共有できないため、応答型はここで定義する。
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

export async function fetchUsage(): Promise<UsagePayload | Unauthorized | null> {
  const response = await fetch("/api/usage", { headers: { accept: "application/json" } });

  if (response.status === 401) {
    return { unauthorized: true };
  }

  if (!response.ok) {
    return null;
  }

  return parseUsage(await response.json().catch(() => null));
}

export async function fetchCodexAuth(): Promise<CodexAuthState | Unauthorized | null> {
  const response = await fetch("/api/codex/auth", { headers: { accept: "application/json" } });

  if (response.status === 401) {
    return { unauthorized: true };
  }

  if (!response.ok) {
    return null;
  }

  return parseCodexAuth(await response.json().catch(() => null));
}

export async function startCodexLogin(): Promise<CodexLoginOutcome> {
  const response = await fetch("/api/codex/login", { method: "POST" });
  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const state = parseCodexAuth(body);

    return state ? { ok: true, state } : { ok: false, error: "unavailable" };
  }

  return { ok: false, error: readString(body, "error") ?? "unavailable" };
}

export async function respondCodexLogin(value: string): Promise<string | null> {
  const response = await fetch("/api/codex/login/respond", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

  if (response.ok) {
    return null;
  }

  return readString(await response.json().catch(() => null), "error") ?? "unavailable";
}

export async function cancelCodexLogin(): Promise<void> {
  await fetch("/api/codex/login", { method: "DELETE" });
}

export async function logoutCodex(): Promise<boolean> {
  const response = await fetch("/api/codex/logout", { method: "POST" });

  return response.ok;
}

export async function fetchOpenCodeAccounts(): Promise<OpenCodeAccount[] | Unauthorized | null> {
  const response = await fetch("/api/opencode/accounts", { headers: { accept: "application/json" } });

  if (response.status === 401) {
    return { unauthorized: true };
  }

  if (!response.ok) {
    return null;
  }

  const body: unknown = await response.json().catch(() => null);

  return readObjects(body, "accounts")
    .map(parseOpenCodeAccount)
    .filter((account) => account !== null);
}

export async function createOpenCodeAccount(
  input: OpenCodeAccountInput,
): Promise<OpenCodeAccountOutcome<OpenCodeAccount>> {
  return requestOpenCodeAccount("/api/opencode/accounts", { method: "POST", body: input });
}

export async function updateOpenCodeAccount(
  id: string,
  patch: OpenCodeAccountPatch,
): Promise<OpenCodeAccountOutcome<OpenCodeAccount>> {
  return requestOpenCodeAccount(`/api/opencode/accounts/${encodeURIComponent(id)}`, { method: "PUT", body: patch });
}

export async function deleteOpenCodeAccount(id: string): Promise<boolean> {
  const response = await fetch(`/api/opencode/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });

  return response.ok;
}

async function requestOpenCodeAccount(
  path: string,
  request: { method: "POST" | "PUT"; body: unknown },
): Promise<OpenCodeAccountOutcome<OpenCodeAccount>> {
  const response = await fetch(path, {
    method: request.method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request.body),
  });
  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const account = parseOpenCodeAccount(readObject(body, "account"));

    return account ? { ok: true, value: account } : { ok: false, error: "unavailable" };
  }

  if (response.status === 401) {
    return { ok: false, error: "unauthorized" };
  }

  return { ok: false, error: readString(body, "error") ?? "unavailable" };
}

export function parseUsage(body: unknown): UsagePayload | null {
  const sources = readObjects(body, "sources")
    .map(parseSource)
    .filter((source) => source !== null);

  if (sources.length === 0) {
    return null;
  }

  return {
    generatedAt: readNumber(body, "generatedAt") ?? Date.now(),
    sampleIntervalMs: readNumber(body, "sampleIntervalMs") ?? 300_000,
    sources,
  };
}

export function parseCodexAuth(body: unknown): CodexAuthState | null {
  if (typeof body !== "object" || body === null || typeof (body as { signedIn?: unknown }).signedIn !== "boolean") {
    return null;
  }

  const signedIn = (body as { signedIn: boolean }).signedIn;
  const login = (body as { login?: unknown }).login;

  return { signedIn, login: login === null || login === undefined ? null : parseLogin(login) };
}

export function parseOpenCodeAccount(body: unknown): OpenCodeAccount | null {
  const id = readString(body, "id");
  const name = readString(body, "name");
  const icon = readString(body, "icon");

  if (!id || !name || !icon) {
    return null;
  }

  return { id, name, icon, savedAt: readNumber(body, "savedAt") ?? 0 };
}

function parseSource(value: unknown): UsageSource | null {
  const id = readString(value, "id");
  const provider = readString(value, "provider");

  if (!id || (provider !== "codex" && provider !== "opencode-go")) {
    return null;
  }

  const state = readString(value, "state");

  if (state !== "loading" && state !== "ok" && state !== "stale" && state !== "error") {
    return null;
  }

  const error = readObject(value, "error");

  return {
    id,
    provider,
    name: readString(value, "name") ?? id,
    plan: readString(value, "plan"),
    account: parseSourceAccount(readObject(value, "account")),
    state,
    capturedAt: readNumber(value, "capturedAt"),
    error:
      error && readString(error, "code")
        ? {
            code: readString(error, "code") ?? "",
            message: readString(error, "message") ?? "",
            at: readNumber(error, "at") ?? 0,
          }
        : null,
    limitReached: (value as { limitReached?: unknown }).limitReached === true,
    windows: readObjects(value, "windows")
      .map(parseWindow)
      .filter((window) => window !== null),
    notes: readStrings(value, "notes"),
    trends: readObjects(value, "trends")
      .map(parseTrend)
      .filter((trend) => trend !== null),
  };
}

function parseSourceAccount(value: Record<string, unknown> | null): UsageSourceAccount | null {
  const id = readString(value, "id");

  if (!id) {
    return null;
  }

  return { id, name: readString(value, "name") ?? "", icon: readString(value, "icon") ?? "" };
}

function parseWindow(value: unknown): UsageWindow | null {
  const id = readString(value, "id");
  const label = readString(value, "label");
  const usedPercent = readNumber(value, "usedPercent");

  if (!id || !label || usedPercent === null) {
    return null;
  }

  return {
    id,
    label,
    durationSeconds: readNumber(value, "durationSeconds"),
    usedPercent,
    resetsAt: readNumber(value, "resetsAt"),
  };
}

function parseTrend(value: unknown): Trend | null {
  const windowId = readString(value, "windowId");
  const spanMs = readNumber(value, "spanMs");

  if (!windowId || spanMs === null || spanMs <= 0) {
    return null;
  }

  const points = readObjects(value, "points")
    .map((point) => ({ at: readNumber(point, "at"), usedPercent: readNumber(point, "usedPercent") }))
    .filter((point): point is { at: number; usedPercent: number } => point.at !== null && point.usedPercent !== null);

  return points.length < 2 ? null : { windowId, spanMs, points };
}

function parseLogin(value: unknown): CodexLoginState | null {
  const status = readString(value, "status");

  if (status !== "running" && status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    return null;
  }

  return {
    status,
    instructions: readString(value, "instructions"),
    progress: readString(value, "progress"),
    authUrl: readString(value, "authUrl"),
    userCode: readString(value, "userCode"),
    prompt: parsePrompt(readObject(value, "prompt")),
    error: readString(value, "error"),
  };
}

function parsePrompt(value: Record<string, unknown> | null): CodexLoginPrompt | null {
  const type = readString(value, "type");
  const message = readString(value, "message");

  if (!value || !message) {
    return null;
  }

  if (type === "select") {
    const options = readObjects(value, "options")
      .map((option) => ({ id: readString(option, "id"), label: readString(option, "label") }))
      .filter((option): option is CodexLoginOption => option.id !== null && option.label !== null);

    return options.length === 0 ? null : { type: "select", message, options };
  }

  if (type === "manual_code") {
    return { type: "manual_code", message, placeholder: readString(value, "placeholder") };
  }

  return null;
}

function readObject(body: unknown, key: string): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readObjects(body: unknown, key: string): unknown[] {
  if (typeof body !== "object" || body === null) {
    return [];
  }

  const value = (body as Record<string, unknown>)[key];

  return Array.isArray(value) ? value : [];
}

function readStrings(body: unknown, key: string): string[] {
  return readObjects(body, key).filter((value): value is string => typeof value === "string");
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(body: unknown, key: string): number | null {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
