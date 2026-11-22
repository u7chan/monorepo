import { AdminError } from "./errors";

/** 会話 ID は u7agent が発行する 10 hex。 */
export const SESSION_ID_PATTERN = /^[0-9a-f]{10}$/;
export const SPACE_ID_PATTERN = /^(default|space-[0-9a-f]{16})$/;

export type ConnectionTarget = {
  origin: string;
  sessionId: string;
  spaceId: string;
};

export type SessionUrls = {
  sessionUrl: string;
  sessionApi: string;
  messagesApi: string;
};

/**
 * 会話 URL を貼り付ける入口。クエリの `space` を所属として読み、origin はパスを持たない形へ正規化する。
 * http を受け入れないのは、上流の BFF が無認証で、平文だと中継の外で会話が読めるため。
 */
export function parseSessionUrl(raw: string): ConnectionTarget {
  const value = raw.trim();
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new AdminError(400, "invalid_session_url");
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AdminError(400, "invalid_session_url");
  }

  const sessionId = /^\/s\/([0-9a-f]{10})$/.exec(url.pathname)?.[1];

  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new AdminError(400, "invalid_session_url");
  }

  const spaceId = url.searchParams.get("space") ?? "default";

  if (!SPACE_ID_PATTERN.test(spaceId)) {
    throw new AdminError(400, "invalid_session_url");
  }

  return { origin: url.origin, sessionId, spaceId };
}

/** 会話を新規作成するときの origin。中継と同じく HTTPS だけを受け付け、パス・資格情報は拒否する。 */
export function parseOrigin(raw: string): string {
  const value = raw.trim();
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new AdminError(400, "invalid_origin");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new AdminError(400, "invalid_origin");
  }

  return url.origin;
}

export function parseSpaceId(raw: string): string {
  const value = raw.trim() || "default";

  if (!SPACE_ID_PATTERN.test(value)) {
    throw new AdminError(400, "invalid_space_id");
  }

  return value;
}

export function sessionUrls(target: ConnectionTarget): SessionUrls {
  const sessionPath = `/api/sessions/${target.sessionId}`;
  const query = `spaceId=${encodeURIComponent(target.spaceId)}`;

  return {
    sessionUrl: new URL(`/s/${target.sessionId}?space=${encodeURIComponent(target.spaceId)}`, target.origin).href,
    sessionApi: new URL(`${sessionPath}?${query}`, target.origin).href,
    messagesApi: new URL(`${sessionPath}/messages?${query}`, target.origin).href,
  };
}

/** 表示用。保存済みの値が壊れていても throw せず、リンクを出さない判断に使う。 */
export function safeSessionUrl(origin: string, sessionId: string, spaceId: string): string | null {
  try {
    return sessionUrls({ origin, sessionId, spaceId }).sessionUrl;
  } catch {
    return null;
  }
}
