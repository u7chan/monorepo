import type { ConnectionRecord, Store } from "./db";
import { AdminError, UpstreamError } from "./errors";
import { extractRunAssets, type RunAsset } from "./assets";
import { hashToken, matchesHash } from "./keys";
import { sessionUrls } from "./targets";
import type { UpstreamClient, UpstreamSession } from "./upstream";

const IDLE_STATUSES = new Set(["idle", "completed", "stopped", "error"]);

export type ReplyPayload =
  | { status: "running" }
  | { status: "awaiting_answer"; sessionUrl: string }
  | { status: "completed"; text: string; files: RunAsset[] }
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

        // この GET で前回の完了結果を取得しているなら、次の投稿で上流の最新実行が
        // 置き換わる前に保存する。取りこぼすと返信 API から二度と読めなくなる。
        persistCompletedRuns(store, connection, session, now());

        if (!IDLE_STATUSES.has(session.status) || (session.queueDepth ?? 0) !== 0) {
          throw new AdminError(409, "session_busy");
        }

        // 上流の GET を待つ間にキーが失効・削除されることがある。POST の直前に有効性を確かめる。
        if (!store.isKeyActiveForConnection(keyId, connection.id)) {
          throw new AdminError(401, "unauthorized");
        }

        const accepted = await upstream.postMessage(connection, text);
        const urls = sessionUrls(connection);

        // 上流のキューに積まれた投稿は実行 ID を持たない。呼び出し側は会話を開いて確認する。
        if (accepted.queued) {
          return { status: "queued", sessionUrl: urls.sessionUrl };
        }

        const at = now();

        const inserted = store.insertRun({
          runId: accepted.runId,
          connectionId: connection.id,
          keyId,
          status: "running",
          sessionUrl: urls.sessionUrl,
          createdAt: at,
          updatedAt: at,
        });

        if (!inserted) {
          // 応答を待つ間に接続先が削除された。履歴を残さず、キーも無効として扱う。
          throw new AdminError(401, "unauthorized");
        }

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
        return terminalPayload(run.status, run.text, store.getRunAssets(runId));
      }

      const session = await upstream.readSession(connection);

      // 上流を待つ間に、投稿前処理や定期照会がこの実行の終端結果を保存していることがある。
      // 上流が次の実行へ進んでいても、保存済みの結果があれば 404 にしない。
      const saved = store.getRun(runId);

      if (saved && isTerminal(saved.status)) {
        return terminalPayload(saved.status, saved.text, store.getRunAssets(runId));
      }

      if (session.run?.id !== runId) {
        // 上流は直近の実行だけを返す。追い越された実行は、終了済みとして保存した分しか答えられない。
        throw new AdminError(404, "run_not_found");
      }

      const payload = sessionRunPayload(session, runId, connection);

      if (payload.status === "running") {
        return payload;
      }

      store.completeRun(
        runId,
        payload.status,
        payload.status === "completed" ? payload.text : null,
        payload.status === "error" ? "upstream_error" : null,
        payload.status === "completed" ? payload.files : [],
        now(),
      );

      // 上流を待つ間に、定期照会や投稿前処理が終端状態を保存していることがある。
      // その場合は、遅れて届いた未終端の応答で上書きせず、保存済みの結果を返す。
      const latest = store.getRun(runId);

      return latest && isTerminal(latest.status)
        ? terminalPayload(latest.status, latest.text, store.getRunAssets(runId))
        : payload;
    },
  };
}

export function sessionRunPayload(session: UpstreamSession, runId: string, connection: ConnectionRecord): ReplyPayload {
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

      return { status: "completed", text: reply?.text ?? "", files: extractRunAssets(session.messages, runId) };
    }
    case "stopped":
    case "error":
      return { status: run.status };
    default:
      throw new UpstreamError(502, "upstream_invalid");
  }
}

function isTerminal(status: string): status is "completed" | "stopped" | "error" {
  return status === "completed" || status === "stopped" || status === "error";
}

function terminalPayload(
  status: "completed" | "stopped" | "error",
  text: string | null,
  files: RunAsset[],
): ReplyPayload {
  return status === "completed" ? { status, text: text ?? "", files } : { status };
}

/** 上流の最新実行と一致する未終端の履歴を、取得済みのセッションから確定させる。 */
function persistCompletedRuns(store: Store, connection: ConnectionRecord, session: UpstreamSession, now: number): void {
  for (const run of store.listPendingRunsForConnection(connection.id)) {
    if (session.run?.id !== run.runId) {
      continue;
    }

    try {
      const payload = sessionRunPayload(session, run.runId, connection);

      if (payload.status === "running") {
        continue;
      }

      store.completeRun(
        run.runId,
        payload.status,
        payload.status === "completed" ? payload.text : null,
        payload.status === "error" ? "upstream_error" : null,
        payload.status === "completed" ? payload.files : [],
        now,
      );
    } catch {
      // 解釈できない応答は次の周期に回す。
    }
  }
}
