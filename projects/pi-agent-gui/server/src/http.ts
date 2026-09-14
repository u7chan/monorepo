import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SandboxRequestError } from "./sandbox/client";

const MAX_BODY_BYTES = 64 * 1024;

export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    if (typeof value === "number") return value;
  }
  return undefined;
}

export function httpError(statusCode: number, message: string): Error {
  const error = new Error(message);
  (error as { statusCode?: number }).statusCode = statusCode;
  return error;
}

/** Content-Length を信用せず、body を読みながら上限を見る。 */
async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw httpError(413, "Request body is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * /api/* の POST/PATCH/PUT に適用するボディガード。
 * 読み取ったテキストを Hono の bodyCache に戻して、後段の zValidator に再読み込みを許す。
 */
export async function bodyGuard(c: Context, next: () => Promise<void>) {
  const method = c.req.method;
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return c.json({ error: "Request body is too large" }, 413);
    }
    const text = await readBodyText(c.req.raw, MAX_BODY_BYTES);
    // bodyCache の型は解決後の値だが、ランタイムは Promise を期待するため型を吐く。
    (c.req.bodyCache as { text?: unknown }).text = Promise.resolve(text.trim() ? text : "{}");
  }
  await next();
}

/** サンドボックスの 4xx はそのまま、接続失敗は 502 にして応答する。 */
export function sandboxFailure(c: Context, error: unknown) {
  return c.json(
    { error: messageFor(error) },
    (error instanceof SandboxRequestError ? error.status : 502) as ContentfulStatusCode,
  );
}

export function sandboxNotConfigured(c: Context) {
  return c.json({ error: "サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)" }, 503);
}
