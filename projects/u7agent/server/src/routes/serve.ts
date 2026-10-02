import type { Context } from "hono";
import { sandboxFailure } from "../http";
import type { ServeStartBody, ServeStopBody } from "../schema";
import type { ServeService } from "../serve";

/**
 * serve (サービス) の状態と起動・停止。閲覧中の会話 id を受け取り、作業ディレクトリは会話ストアから
 * 解決する (client は cwd を送らない。サーバーが唯一の解決点)。
 * 稼働判定の失敗 (プローブ / サンドボックス呼び出し) は 502 / 503 で返し、停止中へ丸めない。
 */
export function createServeRoutes({ serve }: { serve: ServeService }) {
  const failure = (c: Context, error: unknown) => {
    // httpError の分類 (403 / 404 / 409 / 502 / 503) はそのまま返す
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number") return c.json({ error: messageFor(error) }, status as 400);
    return sandboxFailure(c, error);
  };

  return {
    status: async (c: Context) => {
      const sessionId = (c.req.query("sessionId") ?? "").trim();
      if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
      try {
        return c.json(await serve.status(sessionId));
      } catch (error) {
        return failure(c, error);
      }
    },

    start: async (c: Context, body: ServeStartBody) => {
      try {
        return c.json(
          await serve.start(body.sessionId, { command: body.command, generation: body.generation ?? null }),
        );
      } catch (error) {
        return failure(c, error);
      }
    },

    stop: async (c: Context, body: ServeStopBody) => {
      try {
        return c.json(await serve.stop(body.sessionId, { generation: body.generation ?? null }));
      } catch (error) {
        return failure(c, error);
      }
    },
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
