import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { MAX_ATTACHMENT_BYTES, composePrompt, normalizeAttachmentPaths, toAttachmentPath } from "../attachments";
import { sessionUploadsRel, workspaceAbs } from "../app-paths";
import { sandboxFailure, sandboxNotConfigured } from "../http";
import { isValidUploadName } from "../sandbox/protocol";
import type { SandboxWorkspaceClient } from "../sandbox/client";
import {
  FileUploadSchema,
  type CreateSessionBody,
  type PostMessageBody,
  type UpdateSessionSettingsBody,
} from "../schema";
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

export function createSessionRoutes({
  store,
  workspace,
}: {
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
}) {
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
      const attachments = normalizeAttachmentPaths(body.attachments, sessionUploadsRel(record.id));
      const text = body.text.trim();
      // 本文が空でも添付だけで送れる (注記だけのプロンプトになる)
      if (!text && attachments.length === 0) return c.json({ error: "text is required" }, 400);
      if (text.length > MAX_MESSAGE_CHARS) {
        return c.json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` }, 413);
      }
      // 実行 (またはキュー位置) は SessionStore がバックグラウンドで進めるため即座に返す。
      // 注記は履歴とモデルへ渡すためここで合成し、title は注記を除いた本文から作る。
      // 保存先はプロジェクトの外にあるため、モデルへは絶対パスで知らせる
      const result = store.postMessage(
        record,
        composePrompt(
          text,
          attachments.map((path) => workspaceAbs(store.rootCwd, path)),
        ),
      );
      return c.json({ sessionId: record.id, status: store.statusOf(record), ...result }, 202);
    },

    /**
     * 選択時の即時アップロード。bodyGuard (64 KiB 上限 / text 化) を通さないよう、app.ts では
     * このルートを bodyGuard より先に登録する。保存先は所属に関係なく `<appdir>/uploads/<sessionId>/`
     * (プロジェクトのリポジトリ内にファイルを作らない)。
     */
    uploadFile: async (c: Context) => {
      if (!workspace) return sandboxNotConfigured(c);
      const record = await resolveRecord(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const name = c.req.query("name") ?? "";
      if (!isValidUploadName(name)) return c.json({ error: `Invalid file name: ${name}` }, 400);
      // サンドボックスはストリームを数えて 413 を返すが、事前に分かる分はここで止める (本文を送らずに済む)
      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: `File is too large (max ${MAX_ATTACHMENT_BYTES} bytes)` }, 413);
      }
      const uploadsDirRel = sessionUploadsRel(record.id);
      try {
        const uploaded = await workspace.uploadFile({
          dir: uploadsDirRel,
          name,
          body: c.req.raw.body,
          signal: c.req.raw.signal,
        });
        const parsed = FileUploadSchema.safeParse(uploaded);
        if (!parsed.success) return c.json({ error: "サンドボックスのアップロード応答が不正です" }, 502);
        // サンドボックスは root 相対を返す。保存先の外や別セッションを指す応答は 502 で止める
        const path = toAttachmentPath(uploadsDirRel, parsed.data.path);
        if (!path) return c.json({ error: "サンドボックスのアップロード応答が不正です" }, 502);
        return c.json({ sessionId: record.id, ...parsed.data, path }, 201);
      } catch (error) {
        return sandboxFailure(c, error);
      }
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
          // dev の Vite プロキシは upstream が落ちても接続を閉じないため、クライアントは無音で切断を
          // 検知する。コメント行 (`:`) は EventSource のイベントにならず見えないので可視イベントで送る。
          // id を付けないので Last-Event-ID (差分再開のカーソル) は動かない
          const ping = () => stream.writeSSE({ event: "ping", data: "{}" });
          void ping();
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
          const heartbeat = setInterval(() => void ping(), SSE_HEARTBEAT_MS);
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
