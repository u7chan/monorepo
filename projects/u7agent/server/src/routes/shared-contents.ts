import type { Context } from "hono";
import { messageFor, statusCodeOf } from "../http";
import type { CreateSharedContentBody } from "../schema";
import type { SharedContentsService } from "../shared-contents";

/**
 * 共有コンテンツの公開 API。作成・更新は 202 で受け付け、状態は GET で読む。
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
  };
}

function failure(c: Context, error: unknown) {
  const status = statusCodeOf(error) ?? 500;
  return c.json({ error: messageFor(error), state: "not_stored" as const }, status as 400);
}
