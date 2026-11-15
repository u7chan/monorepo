import type { Context } from "hono";
import { messageFor, readRawBody, statusCodeOf } from "../http";
import type { CreateSharedContentBody, RenameSharedContentBody } from "../schema";
import {
  SHARED_CONTENT_THUMBNAIL_TOO_LARGE,
  SharedContentStoredFailure,
  type SharedContentsService,
} from "../shared-contents";
import { SHARED_THUMBNAIL_MAX_BYTES, SHARED_THUMBNAIL_MIME } from "../shared-thumbnails";

/**
 * 共有コンテンツの管理 API。作成・更新・再公開は 202 で受け付け、状態は GET で読む。
 * 停止は provider の結果を status で返すため 200、削除は本文なしの 204。
 * 失敗応答の `state: "not_stored"` は、この要求で行を保存しなかったときだけ付ける
 * (読み取りは何も保存しないので付けない)。
 */
export function createSharedContentRoutes({ sharedContents }: { sharedContents: SharedContentsService }) {
  return {
    list: (c: Context) => {
      try {
        // 会話の絞り込みは hc の要求型を推論させるため handler の本体で読む (client は全共有物の一覧を持たない)
        const sessionId = (c.req.query("sessionId") ?? "").trim();
        return c.json({ items: sharedContents.list(sessionId === "" ? undefined : sessionId) });
      } catch (error) {
        return readFailure(c, error);
      }
    },

    detail: (c: Context) => {
      try {
        return c.json(sharedContents.get(c.req.param("id") ?? ""));
      } catch (error) {
        return readFailure(c, error);
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
        return readFailure(c, error);
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

    /** 表示名だけの変更。provider を呼ばず、状態も変えないので 200 で確定する */
    rename: (c: Context, body: RenameSharedContentBody) => {
      try {
        return c.json(sharedContents.rename(c.req.param("id") ?? "", body), 200);
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

    /**
     * サムネイルの PNG を raw で受ける。`Content-Type` と実バイト数だけをここで見て、
     * PNG の構造検証は service（保存と同じ層）に置く。
     */
    putThumbnail: async (c: Context) => {
      const id = c.req.param("id") ?? "";
      const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType !== SHARED_THUMBNAIL_MIME) {
        return c.json({ error: "PNG でない画像は保存できません", state: "not_stored" as const }, 415);
      }
      try {
        const bytes = await readRawBody(c.req.raw, SHARED_THUMBNAIL_MAX_BYTES, SHARED_CONTENT_THUMBNAIL_TOO_LARGE);
        return c.json({ thumbnail: await sharedContents.setThumbnail(id, bytes) }, 200);
      } catch (error) {
        return failure(c, error);
      }
    },

    /** サムネイルだけを外す。未設定でも 204（結果不明の再試行で 404 にしない） */
    removeThumbnail: async (c: Context) => {
      try {
        await sharedContents.removeThumbnail(c.req.param("id") ?? "");
        return c.body(null, 204);
      } catch (error) {
        return failure(c, error);
      }
    },

    /**
     * 保存済みのサムネイル。版を URL に載せる前提なので長期キャッシュを許可し、
     * 内容が変われば `?v=` が変わる（`no-store` にすると一覧のたびに 2 MiB を取り直す）。
     */
    thumbnail: async (c: Context) => {
      try {
        const { bytes } = await sharedContents.readThumbnail(c.req.param("id") ?? "");
        const body =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
        return c.body(body as ArrayBuffer, 200, {
          "Content-Type": SHARED_THUMBNAIL_MIME,
          // 行のメタではなく実バイト数を返す（実体が外部で置き換わっても長さを偽らない）
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        });
      } catch (error) {
        return readFailure(c, error);
      }
    },
  };
}

/** 変更系の失敗。行を保存した失敗だけ `state` を落とす (保存の有無は service が持つ事実を使う) */
function failure(c: Context, error: unknown) {
  const status = (statusCodeOf(error) ?? 500) as 400;
  const body = { error: messageFor(error) };
  return error instanceof SharedContentStoredFailure
    ? c.json(body, status)
    : c.json({ ...body, state: "not_stored" as const }, status);
}

/** 一覧・詳細・プレビュー (GET) の失敗。読み取りは何も保存しないので `state` を付けない */
function readFailure(c: Context, error: unknown) {
  return c.json({ error: messageFor(error) }, (statusCodeOf(error) ?? 500) as 400);
}
