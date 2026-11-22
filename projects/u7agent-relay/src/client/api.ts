export type SessionState =
  | { state: "setup_required"; version: string }
  | { state: "unauthenticated"; version: string }
  | { state: "misconfigured"; version: string }
  | { state: "authenticated"; expiresAt: number; version: string };

export type ConnectionView = {
  id: string;
  name: string;
  sessionId: string;
  spaceId: string;
  keyCount: number;
  createdAt: number;
  updatedAt: number;
};

export type KeyView = {
  id: string;
  connectionId: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

export type RunStatus = "running" | "awaiting_answer" | "completed" | "stopped" | "error";

export type RunView = {
  runId: string;
  connectionId: string;
  keyId: string;
  keyName: string | null;
  status: RunStatus;
  text: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type StatePayload = {
  version: string;
  connections: ConnectionView[];
  keys: KeyView[];
  runs: RunView[];
};

export type CheckResult = {
  status: string;
  title: string | null;
  queueDepth: number;
  awaitingAnswer: boolean;
  checkedAt: number;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network_error");
  }

  if (response.status === 204) {
    return null;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const body = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const code = typeof body.error === "string" ? body.error : "unknown_error";
    const retryAfterSeconds = typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined;

    throw new ApiError(response.status, code, retryAfterSeconds);
  }

  return payload;
}

export function fetchSession(): Promise<SessionState> {
  return request("/api/auth/session") as Promise<SessionState>;
}

export function submitPin(path: "/api/auth/setup" | "/api/auth/login", pin: string): Promise<unknown> {
  return request(path, { method: "POST", body: JSON.stringify({ pin }) });
}

export function logout(): Promise<unknown> {
  return request("/api/auth/logout", { method: "POST" });
}

export function fetchState(): Promise<StatePayload> {
  return request("/api/state") as Promise<StatePayload>;
}

export function addConnection(name: string, sessionUrl: string): Promise<unknown> {
  return request("/api/connections", { method: "POST", body: JSON.stringify({ name, sessionUrl }) });
}

export function createConnection(name: string, origin: string, spaceId: string): Promise<unknown> {
  return request("/api/connections/create", { method: "POST", body: JSON.stringify({ name, origin, spaceId }) });
}

export function updateConnection(id: string, name: string): Promise<unknown> {
  return request(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function deleteConnection(id: string): Promise<{ deletedKeys: number }> {
  return request(`/api/connections/${id}`, { method: "DELETE" }) as Promise<{ deletedKeys: number }>;
}

export function checkConnection(id: string): Promise<CheckResult> {
  return request(`/api/connections/${id}/check`, { method: "POST" }) as Promise<CheckResult>;
}

export function createKey(name: string, connectionId: string): Promise<{ key: KeyView; token: string }> {
  return request("/api/keys", { method: "POST", body: JSON.stringify({ name, connectionId }) }) as Promise<{
    key: KeyView;
    token: string;
  }>;
}

export function revokeKey(id: string): Promise<unknown> {
  return request(`/api/keys/${id}/revoke`, { method: "POST" });
}

export function deleteKey(id: string): Promise<unknown> {
  return request(`/api/keys/${id}`, { method: "DELETE" });
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_pin: "PIN が違います。",
  already_configured: "PIN は設定済みです。ログインしてください。",
  setup_required: "PIN が未設定です。初回セットアップをしてください。",
  misconfigured: "サーバーの認証設定が壊れています。データディレクトリを確認してください。",
  rate_limited: "試行回数が多すぎます。しばらく待ってください。",
  origin_mismatch: "別のオリジンからの要求は受け付けられません。",
  invalid_request: "入力の形式が正しくありません。",
  invalid_name: "名前は 1〜64 文字で入力してください。",
  invalid_session_url: "会話 URL が正しくありません。https://…/s/<id> の形式で入力してください。",
  invalid_origin: "接続先の origin が正しくありません。https://host の形式で入力してください。",
  invalid_space_id: "スペース ID が正しくありません。",
  duplicate_connection: "同じ会話がすでに登録されています。",
  session_url_immutable: "会話を変えるには、新しい接続先を登録してキーを発行し直してください。",
  connection_not_found: "接続先が見つかりません。",
  key_not_found: "API キーが見つかりません。",
  run_not_found: "実行が見つかりません。",
  session_busy: "会話が実行中か、送信待ちがあります。完了してから再試行してください。",
  json_required: "Content-Type: application/json が必要です。",
  text_required: "text を指定してください。",
  message_too_large: "本文が長すぎます。",
  upstream_rejected: "u7agent が要求を受け付けませんでした。",
  upstream_timeout: "u7agent への接続がタイムアウトしました。",
  upstream_unavailable: "u7agent に接続できませんでした。",
  upstream_mismatch: "u7agent の応答が接続先と一致しません。",
  upstream_invalid: "u7agent の応答を解釈できませんでした。",
  unauthorized: "ログインが必要です。",
  network_error: "通信に失敗しました。もう一度試してください。",
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return ERROR_MESSAGES[error.code] ?? `エラーが発生しました (${error.code})。`;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "エラーが発生しました。";
}
