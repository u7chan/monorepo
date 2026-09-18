import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { CreateSessionBody, PostMessageBody, UpdateSessionSettingsBody } from "../schema";
import type { SessionStore } from "../sessions";

// sessions 側の上限とは別 (HTTP 層の契約)
const MAX_MESSAGE_CHARS = 20_000;
const SSE_HEARTBEAT_MS = 15_000;

/** streamSSE は charset 等を設定しないため、SSE のヘッダをここで上書きする */
function withSseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

export function createSessionRoutes({ store }: { store: SessionStore }) {
  // 未ロードのセッションはストアから復元する (SDK ロードを含むため非同期)
  const resolveRecord = (c: Context) => store.resolve(c.req.param("id") ?? "");

  const stop = async (c: Context) => {
    const record = await resolveRecord(c);
    if (!record) return c.json({ error: "Session not found" }, 404);
    const result = await store.stop(record);
    return c.json({ sessionId: record.id, ...result });
  };

  return {
    list: (c: Context) => c.json({ sessions: store.list() }),

    create: async (c: Context, body: CreateSessionBody) => {
      const record = await store.create({
        agentId: body.agentId,
        model: body.model,
        thinkingLevel: body.thinkingLevel,
        projectId: body.projectId,
      });
      return c.json(store.payload(record), 201);
    },

    get: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      return c.json(store.payload(record));
    },

    updateSettings: async (c: Context, body: UpdateSessionSettingsBody) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      if (body.model === undefined && body.thinkingLevel === undefined) {
        return c.json({ error: "model or thinkingLevel is required" }, 400);
      }
      const payload = await store.updateSettings(record, {
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
      return c.json(payload);
    },

    remove: async (c: Context) => {
      // 未ロードでも消せる (SDK を開かない。履歴だけ削除し、作業フォルダは残す)
      const deleted = await store.deleteSession(c.req.param("id") ?? "");
      if (!deleted) return c.json({ error: "Session not found" }, 404);
      return c.json({ ok: true });
    },

    stop,

    postMessage: async (c: Context, body: PostMessageBody) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const text = body.text.trim();
      if (!text) return c.json({ error: "text is required" }, 400);
      if (text.length > MAX_MESSAGE_CHARS) {
        return c.json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` }, 413);
      }
      // 実行 (またはキュー位置) は SessionStore がバックグラウンドで進めるため即座に返す。
      const result = store.postMessage(record, text);
      return c.json({ sessionId: record.id, status: store.statusOf(record), ...result }, 202);
    },

    events: async (c: Context) => {
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      // 有効な Last-Event-ID (`<generation>:<seq>`) を優先し、無効なら query の generation + after を使う
      const lastEventId = c.req.header("Last-Event-ID");
      const queryGeneration = c.req.query("generation");
      const queryAfter = c.req.query("after");
      const query = queryGeneration ? `${queryGeneration}:${queryAfter ?? "0"}` : queryAfter;
      const after = lastEventId?.includes(":") ? lastEventId : query;

      return withSseHeaders(
        streamSSE(c, async (stream) => {
          let requestCleanup: () => void = () => {};
          stream.onAbort(() => requestCleanup());
          await stream.write(": connected\n\n");
          if (stream.aborted) return;
          const unsubscribe = store.subscribe(
            record,
            after,
            (entry) => {
              void stream.writeSSE({
                // 世代を含める。再起動で seq が戻っても、古いタブのカーソルを resync へ寄せられる
                id: `${record.generation}:${entry.seq}`,
                event: entry.type,
                data: JSON.stringify(entry.data),
              });
            },
            () => requestCleanup(),
          );
          const heartbeat = setInterval(() => {
            void stream.write(": ping\n\n");
          }, SSE_HEARTBEAT_MS);
          heartbeat.unref?.();
          // 切断 (onAbort) と store の close のどちらからでも同じ後始末を通す。
          await new Promise<void>((resolveCleanup) => {
            requestCleanup = () => {
              clearInterval(heartbeat);
              unsubscribe();
              resolveCleanup();
            };
          });
        }),
      );
    },
  };
}
