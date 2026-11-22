import type { ConnectionRecord, Store } from "./db";
import { AdminError, UpstreamError } from "./errors";
import { hashToken, matchesHash } from "./keys";
import { sessionUrls } from "./targets";
import type { UpstreamClient, UpstreamSession } from "./upstream";

const IDLE_STATUSES = new Set(["idle", "completed", "stopped", "error"]);

export type ReplyPayload =
  | { status: "running" }
  | { status: "awaiting_answer"; sessionUrl: string }
  | { status: "completed"; text: string }
  | { status: "stopped" }
  | { status: "error" };

export type PostPayload = { runId: string } | { status: "queued"; sessionUrl: string };

export type AuthenticatedKey = { keyId: string; connection: ConnectionRecord };

export type Relay = ReturnType<typeof createRelay>;

export function createRelay(options: { store: Store; upstream: UpstreamClient; now: () => number }) {
  const { store, upstream, now } = options;
  /** 接続先ごとに 1 実行だけ通す。同じ会話へ別のキーから同時に投稿すると、上流のキューに積まれる。 */
  const inFlight = new Set<string>();

  return {
    /** Bearer の照合。失効・接続先の消失もここで落とし、呼び出し側に区別を見せない。 */
    authenticate(token: string): AuthenticatedKey | null {
      const hash = hashToken(token);
      const key = store.findKeyByHash(hash);

      // 索引で引いた後もハッシュを突き合わせる。保存値が壊れていた場合に通さないため。
      if (!key || key.revokedAt !== null || !matchesHash(token, key.hash)) {
        return null;
      }

      const connection = store.getConnection(key.connectionId);

      if (!connection) {
        return null;
      }

      store.touchKey(key.id, now());

      return { keyId: key.id, connection };
    },

    async post(connection: ConnectionRecord, keyId: string, text: string): Promise<PostPayload> {
      if (inFlight.has(connection.id)) {
        throw new AdminError(409, "session_busy");
      }

      inFlight.add(connection.id);

      try {
        const session = await upstream.readSession(connection);

        if (!IDLE_STATUSES.has(session.status) || (session.queueDepth ?? 0) !== 0) {
          throw new AdminError(409, "session_busy");
        }

        const accepted = await upstream.postMessage(connection, text);
        const urls = sessionUrls(connection);

        // 上流のキューに積まれた投稿は実行 ID を持たない。呼び出し側は会話を開いて確認する。
        if (accepted.queued) {
          return { status: "queued", sessionUrl: urls.sessionUrl };
        }

        const at = now();

        store.insertRun({
          runId: accepted.runId,
          connectionId: connection.id,
          keyId,
          status: "running",
          sessionUrl: urls.sessionUrl,
          createdAt: at,
          updatedAt: at,
        });

        return { runId: accepted.runId };
      } finally {
        inFlight.delete(connection.id);
      }
    },

    async reply(connection: ConnectionRecord, keyId: string, runId: string): Promise<ReplyPayload> {
      const run = store.getRun(runId);

      // 他のキーの実行を見せない。同じ接続先でも、発行したキーだけが結果を読める。
      if (!run || run.keyId !== keyId || run.connectionId !== connection.id) {
        throw new AdminError(404, "run_not_found");
      }

      if (run.status === "completed" || run.status === "stopped" || run.status === "error") {
        return terminalPayload(run.status, run.text);
      }

      const session = await upstream.readSession(connection);

      if (session.run?.id !== runId) {
        // 上流は直近の実行だけを返す。追い越された実行は、終了済みとして保存した分しか答えられない。
        throw new AdminError(404, "run_not_found");
      }

      const payload = payloadOf(session, runId, connection);

      if (payload.status !== "running") {
        store.updateRun(
          runId,
          payload.status,
          payload.status === "completed" ? payload.text : null,
          payload.status === "error" ? "upstream_error" : null,
          now(),
        );
      }

      return payload;
    },
  };
}

function payloadOf(session: UpstreamSession, runId: string, connection: ConnectionRecord): ReplyPayload {
  const run = session.run;

  if (!run || run.id !== runId) {
    throw new UpstreamError(502, "upstream_invalid");
  }

  switch (run.status) {
    case "running": {
      const waiting = run.toolCalls?.some(
        (tool) => tool.done === false && (tool.questions?.length ?? 0) > 0 && tool.answers === undefined,
      );

      return waiting
        ? { status: "awaiting_answer", sessionUrl: sessionUrls(connection).sessionUrl }
        : { status: "running" };
    }
    case "completed": {
      const reply = session.messages?.findLast(
        (message) =>
          message.role === "assistant" && message.assistantId?.startsWith(`${runId}:`) && message.text?.trim(),
      );

      return { status: "completed", text: reply?.text ?? "" };
    }
    case "stopped":
    case "error":
      return { status: run.status };
    default:
      throw new UpstreamError(502, "upstream_invalid");
  }
}

function terminalPayload(status: "completed" | "stopped" | "error", text: string | null): ReplyPayload {
  return status === "completed" ? { status, text: text ?? "" } : { status };
}
