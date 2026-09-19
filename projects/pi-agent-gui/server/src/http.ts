import type { Context, Env, Input, MiddlewareHandler, TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { SandboxRequestError } from "./sandbox/client";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_BODY_BYTES = 64 * 1024 * 1024;

function bodyLimitFor(path: string): number {
  return /^\/api\/sessions\/[^/]+\/messages$/.test(path) ? MAX_MESSAGE_BODY_BYTES : MAX_BODY_BYTES;
}

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

/** 検証失敗時に route 側が返す応答。戻り値型に渡すことで 400 の応答型を route の契約に残す */
type JsonBodyErrorResponse = Response | TypedResponse<{ error: string }, 400, "json">;

type JsonBodyParseResult<S extends z.ZodType> = z.ZodSafeParseResult<z.output<S>>;

/** addValidatedData が object しか受け取らないため、body schema の出力は object に限定する */
type JsonBodySchema = z.ZodType<object>;

/**
 * Content-Type を見ずに JSON body を読む zValidator("json") の代替。
 * zValidator は Content-Type が JSON でなければ body を読まず {} を検証するため、旧 readJsonBody と同じ入力解釈を保つ。
 */
export function jsonBodyValidator<
  S extends JsonBodySchema,
  E extends Env = any,
  P extends string = string,
  V extends Input = { in: { json: z.input<S> }; out: { json: z.output<S> } },
>(
  schema: S,
  hook: (result: JsonBodyParseResult<S>, c: Context<E, P>) => JsonBodyErrorResponse | void,
): MiddlewareHandler<E, P, V, JsonBodyErrorResponse> {
  return async (c, next) => {
    const text = (await c.req.text()).trim();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw httpError(400, "Request body must be valid JSON");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // hook が応答を返さない場合も、未検証の body のまま handler を動かさない
      return hook(result, c) ?? c.json({ error: "Invalid request body" }, 400);
    }
    c.req.addValidatedData("json", result.data);
    await next();
  };
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
 * 読み取ったテキストを Hono の bodyCache に戻して、後段の body validator に再読み込みを許す。
 */
export async function bodyGuard(c: Context, next: () => Promise<void>) {
  const method = c.req.method;
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const maxBytes = bodyLimitFor(c.req.path);
    const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return c.json({ error: "Request body is too large" }, 413);
    }
    const text = await readBodyText(c.req.raw, maxBytes);
    // bodyCache の型は解決後の値だが、ランタイムは Promise を期待するため型を吐く。
    (c.req.bodyCache as { text?: unknown }).text = Promise.resolve(text.trim() ? text : "{}");
  }
  await next();
}

/** サンドボックスの 4xx はそのまま、接続失敗は 502 に寄せる。応答の本文の形は呼び出し側が決める。 */
export function sandboxFailureStatus(error: unknown): number {
  return error instanceof SandboxRequestError ? error.status : 502;
}

/** サンドボックスの 4xx はそのまま、接続失敗は 502 にして応答する。 */
export function sandboxFailure(c: Context, error: unknown) {
  return c.json({ error: messageFor(error) }, sandboxFailureStatus(error) as ContentfulStatusCode);
}

/** 未設定時の案内。JSON と HTML の両方の応答で同じ文言を使う。 */
export const SANDBOX_NOT_CONFIGURED_MESSAGE = "サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)";

export function sandboxNotConfigured(c: Context) {
  return c.json({ error: SANDBOX_NOT_CONFIGURED_MESSAGE }, 503);
}
