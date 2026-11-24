import { UpstreamError } from "./errors";
import { SESSION_ID_PATTERN, SPACE_ID_PATTERN, fileUrls, sessionUrls, type ConnectionTarget } from "./targets";

const RUN_ID_PATTERN = /^[0-9a-f]{16}$/;
/** ファイル取得はヘッダーまでだけを待つ。本文はクライアントの切断で止める。 */
const FILE_HEADER_TIMEOUT_MS = 10_000;

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
  cwd?: string;
  run?: UpstreamRun | null;
  messages?: UpstreamMessage[];
};

export type UpstreamStat = { status: number; path?: string };

export type UpstreamAccepted = { queued: true } | { queued: false; runId: string };

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type UpstreamClient = {
  readSession: (target: ConnectionTarget) => Promise<UpstreamSession>;
  postMessage: (target: ConnectionTarget, text: string) => Promise<UpstreamAccepted>;
  createSession: (origin: string, spaceId: string) => Promise<ConnectionTarget>;
  /** 実在確認と realpath の root 相対パス。400 / 404 は status で返す。 */
  statFile: (target: ConnectionTarget, rootRelativePath: string, signal?: AbortSignal) => Promise<UpstreamStat>;
  fetchRaw: (
    target: ConnectionTarget,
    rootRelativePath: string,
    range: string | null,
    signal?: AbortSignal,
  ) => Promise<Response>;
  fetchDownload: (target: ConnectionTarget, rootRelativePath: string, signal?: AbortSignal) => Promise<Response>;
};

export function createUpstreamClient(
  options: { fetchImpl?: FetchLike; timeoutMs?: number; fileHeaderTimeoutMs?: number } = {},
): UpstreamClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fileHeaderTimeoutMs = options.fileHeaderTimeoutMs ?? FILE_HEADER_TIMEOUT_MS;

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

  async function fetchFile(url: string, headers: HeadersInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fileHeaderTimeoutMs);
    const onAbort = () => controller.abort();
    const requestHeaders = new Headers(headers);

    // 圧縮されると Content-Length が本文と一致しない。ダウンロードは生バイトで受ける。
    requestHeaders.set("Accept-Encoding", "identity");

    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: requestHeaders,
        redirect: "error",
        signal: controller.signal,
      });

      // ここでタイマーを止める。本文の長さは制限せず、クライアント切断だけで止める。
      clearTimeout(timer);

      return response;
    } catch {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      throw timeoutOr(controller.signal, "upstream_unavailable");
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

    async statFile(target, rootRelativePath, signal) {
      const combined = withTimeout(timeoutMs, signal);
      let response: Response;

      try {
        response = await fetchImpl(fileUrls(target, rootRelativePath).statApi, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: combined,
        });
      } catch {
        throw timeoutOr(combined, "upstream_unavailable");
      }

      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});

        return { status: response.status };
      }

      try {
        const payload: unknown = await response.json();
        const path = typeof payload === "object" && payload !== null ? (payload as { path?: unknown }).path : undefined;

        if (typeof path !== "string") {
          throw new UpstreamError(502, "upstream_invalid");
        }

        return { status: 200, path };
      } catch (error) {
        if (error instanceof UpstreamError) {
          throw error;
        }

        throw timeoutOr(combined, "upstream_invalid");
      }
    },

    async fetchRaw(target, rootRelativePath, range, signal) {
      const headers: Record<string, string> = {};

      if (range) {
        headers.Range = range;
      }

      return fetchFile(fileUrls(target, rootRelativePath).rawApi, headers, signal);
    },

    async fetchDownload(target, rootRelativePath, signal) {
      return fetchFile(fileUrls(target, rootRelativePath).downloadApi, {}, signal);
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

/** 指定の期限とクライアント切断のどちらでも止まる signal を作る。 */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);

  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function isSafeRootRelative(value: string): boolean {
  if (value === "" || value === ".") {
    return true;
  }

  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }

  return !value.split("/").includes("..");
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

  if (session.cwd !== undefined && (typeof session.cwd !== "string" || !isSafeRootRelative(session.cwd))) {
    throw new UpstreamError(502, "upstream_invalid");
  }

  return session as UpstreamSession;
}
