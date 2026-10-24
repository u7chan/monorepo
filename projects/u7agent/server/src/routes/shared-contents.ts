import type { Context } from "hono";
import { messageFor, statusCodeOf } from "../http";
import type { CreateSharedContentBody } from "../schema";
import type { SharedContentsService } from "../shared-contents";

/**
 * 共有コンテンツの管理 API。作成・更新・再公開は 202 で受け付け、状態は GET で読む。
 * 停止は provider の結果を status で返すため 200、削除は本文なしの 204。
 * 受付に失敗した要求は何も保存していないため `state: "not_stored"` を付ける。
 */
export function createSharedContentRoutes({ sharedContents }: { sharedContents: SharedContentsService }) {
  return {
    list: (c: Context) => {
      try {
        // 会話の絞り込みは hc の要求型を推論させるため handler の本体で読む (client は全共有物の一覧を持たない)
        const sessionId = (c.req.query("sessionId") ?? "").trim();
        return c.json({ items: sharedContents.list(sessionId === "" ? undefined : sessionId) });
      } catch (error) {
        return failure(c, error);
      }
    },

    detail: (c: Context) => {
      try {
        return c.json(sharedContents.get(c.req.param("id") ?? ""));
      } catch (error) {
        return failure(c, error);
      }
    },

    /**
     * 公開前のプレビュー。`GET /api/shared-contents/:id` より前に登録しないと id="preview" として拾われる。
     * Cloudflare の資格情報は使わない (接続未登録でも見られる)。
     */
    preview: async (c: Context) => {
      try {
        const sessionId = (c.req.query("sessionId") ?? "").trim();
        const directory = c.req.query("directory") ?? "";
        return c.json(await sharedContents.preview({ sessionId, directory }));
      } catch (error) {
        return failure(c, error);
      }
    },

    create: async (c: Context, body: CreateSharedContentBody) => {
      try {
        return c.json(await sharedContents.create(body), 202);
      } catch (error) {
        return failure(c, error);
      }
    },

    publish: async (c: Context) => {
      try {
        return c.json(await sharedContents.publish(c.req.param("id") ?? ""), 202);
      } catch (error) {
        return failure(c, error);
      }
    },

    stop: async (c: Context) => {
      try {
        return c.json(await sharedContents.stop(c.req.param("id") ?? ""), 200);
      } catch (error) {
        return failure(c, error);
      }
    },

    resume: async (c: Context) => {
      try {
        return c.json(await sharedContents.resume(c.req.param("id") ?? ""), 202);
      } catch (error) {
        return failure(c, error);
      }
    },

    remove: async (c: Context) => {
      try {
        await sharedContents.remove(c.req.param("id") ?? "");
        return c.body(null, 204);
      } catch (error) {
        return failure(c, error);
      }
    },
  };
}

function failure(c: Context, error: unknown) {
  const status = statusCodeOf(error) ?? 500;
  return c.json({ error: messageFor(error), state: "not_stored" as const }, status as 400);
}
