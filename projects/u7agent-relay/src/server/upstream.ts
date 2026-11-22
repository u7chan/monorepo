import { UpstreamError } from "./errors";
import { SESSION_ID_PATTERN, SPACE_ID_PATTERN, sessionUrls, type ConnectionTarget } from "./targets";

const RUN_ID_PATTERN = /^[0-9a-f]{16}$/;

export type UpstreamRun = {
  id: string;
  status: string;
  toolCalls?: { done?: boolean; questions?: unknown[]; answers?: unknown }[];
};

export type UpstreamMessage = {
  role: string;
  text?: string;
  assistantId?: string;
};

export type UpstreamSession = {
  sessionId: string;
  spaceId: string;
  status: string;
  queueDepth?: number;
  title?: string;
  awaitingAnswer?: boolean;
  run?: UpstreamRun | null;
  messages?: UpstreamMessage[];
};

export type UpstreamAccepted = { queued: true } | { queued: false; runId: string };

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type UpstreamClient = {
  readSession: (target: ConnectionTarget) => Promise<UpstreamSession>;
  postMessage: (target: ConnectionTarget, text: string) => Promise<UpstreamAccepted>;
  createSession: (origin: string, spaceId: string) => Promise<ConnectionTarget>;
};

export function createUpstreamClient(options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): UpstreamClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  async function request(url: string, init: RequestInit): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;

    try {
      response = await fetchImpl(url, { redirect: "error", signal, ...init });
    } catch {
      throw timeoutOr(signal, "upstream_unavailable");
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => {});

      throw new UpstreamError(502, "upstream_rejected");
    }

    try {
      return await response.json();
    } catch {
      // ヘッダー後の本文読み取りでも期限は続く。旧中継と同じく期限切れは 504 にそろえる。
      throw timeoutOr(signal, "upstream_invalid");
    }
  }

  return {
    async readSession(target) {
      const payload = await request(sessionUrls(target).sessionApi, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      return assertSession(payload, target);
    },

    async postMessage(target, text) {
      const payload = await request(sessionUrls(target).messagesApi, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (typeof payload !== "object" || payload === null) {
        throw new UpstreamError(502, "upstream_invalid");
      }

      const accepted = payload as { sessionId?: unknown; queued?: unknown; runId?: unknown };

      // 202 の応答が別会話を指していれば、この runId を接続先へ紐づけない。
      if (accepted.sessionId !== target.sessionId) {
        throw new UpstreamError(502, "upstream_mismatch");
      }

      // キューに積まれた投稿は実行 ID を持たない。再送すると二重投稿になるので、呼び出し側は追跡しない。
      if (accepted.queued === true) {
        return { queued: true };
      }

      if (accepted.queued !== false || typeof accepted.runId !== "string" || !RUN_ID_PATTERN.test(accepted.runId)) {
        throw new UpstreamError(502, "upstream_invalid");
      }

      return { queued: false, runId: accepted.runId };
    },

    async createSession(origin, spaceId) {
      const payload = await request(new URL("/api/sessions", origin).href, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(spaceId === "default" ? {} : { spaceId }),
      });

      if (typeof payload !== "object" || payload === null) {
        throw new UpstreamError(502, "upstream_invalid");
      }

      const created = payload as { sessionId?: unknown; spaceId?: unknown };
      const createdSpace = typeof created.spaceId === "string" ? created.spaceId : "default";

      if (
        typeof created.sessionId !== "string" ||
        !SESSION_ID_PATTERN.test(created.sessionId) ||
        !SPACE_ID_PATTERN.test(createdSpace) ||
        createdSpace !== spaceId
      ) {
        throw new UpstreamError(502, "upstream_invalid");
      }

      return { origin, sessionId: created.sessionId, spaceId: createdSpace };
    },
  };
}

function timeoutOr(signal: AbortSignal, code: string): UpstreamError {
  return signal.aborted ? new UpstreamError(504, "upstream_timeout") : new UpstreamError(502, code);
}

function assertSession(payload: unknown, target: ConnectionTarget): UpstreamSession {
  if (typeof payload !== "object" || payload === null) {
    throw new UpstreamError(502, "upstream_invalid");
  }

  const session = payload as Partial<UpstreamSession>;

  if (session.sessionId !== target.sessionId || session.spaceId !== target.spaceId) {
    throw new UpstreamError(502, "upstream_mismatch");
  }

  if (typeof session.status !== "string") {
    throw new UpstreamError(502, "upstream_invalid");
  }

  return session as UpstreamSession;
}
