import type { Context, Env, Input, MiddlewareHandler, TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import type { z } from "zod";
import { declaredBodyTooLarge, readBodyBytes, readBodyText } from "./bounded-body";
import { httpError, messageFor, type HttpError } from "./errors";
import { SandboxRequestError, type SandboxDownloadFile } from "./sandbox/client";

/** bodyGuard が読み切って text 化する JSON body の上限 */
const MAX_BODY_BYTES = 64 * 1024;

export { httpError, messageFor, type HttpError };

export function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** 検証失敗時に route 側が返す応答。戻り値型に渡すことで 400 の応答型を route の契約に残す */
type JsonBodyErrorResponse = Response | TypedResponse<{ error: string; state?: "not_stored" }, 400, "json">;

type JsonBodyParseResult<S extends z.ZodType> = z.ZodSafeParseResult<z.output<S>>;

/** addValidatedData が object しか受け取らないため、body schema の出力は object に限定する */
type JsonBodySchema = z.ZodType<object>;

function invalidRequestBody(c: Context) {
  return c.json({ error: "Invalid request body" }, 400);
}

export function requestBodyValidationHook<E extends Env, P extends string>(
  result: { success: boolean },
  c: Context<E, P>,
) {
  if (!result.success) return invalidRequestBody(c);
}

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
  options?: { invalidJson?: (c: Context<E, P>) => JsonBodyErrorResponse },
): MiddlewareHandler<E, P, V, JsonBodyErrorResponse> {
  return async (c, next) => {
    const text = (await c.req.text()).trim();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      if (options?.invalidJson) return options.invalidJson(c);
      throw httpError(400, "Request body must be valid JSON");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // hook が応答を返さない場合も、未検証の body のまま handler を動かさない
      return hook(result, c) ?? invalidRequestBody(c);
    }
    c.req.addValidatedData("json", result.data);
    await next();
  };
}

/**
 * /api/* の POST/PATCH/PUT に適用するボディガード。
 * 読み取ったテキストを Hono の bodyCache に戻して、後段の body validator に再読み込みを許す。
 */
export async function bodyGuard(c: Context, next: () => Promise<void>) {
  const method = c.req.method;
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const limit = MAX_BODY_BYTES;
    const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (declaredBodyTooLarge(contentLength, limit)) {
      return c.json({ error: "Request body is too large" }, 413);
    }
    const text = await readBodyText(c.req.raw.body?.getReader(), limit);
    if (text === undefined) throw httpError(413, "Request body is too large");
    // bodyCache の型は解決後の値だが、ランタイムは Promise を期待するため型を吐く。
    (c.req.bodyCache as { text?: unknown }).text = Promise.resolve(text.trim() ? text : "{}");
  }
  await next();
}

export async function readRawBody(
  request: Request,
  maxBytes: number,
  message = "Request body is too large",
): Promise<Uint8Array> {
  const bytes = await readBodyBytes(request.body?.getReader(), maxBytes);
  if (bytes === undefined) throw httpError(413, message);
  return bytes;
}

/** サンドボックスの 4xx はそのまま、接続失敗は 502 に寄せる。応答の本文の形は呼び出し側が決める。 */
export function sandboxFailureStatus(error: unknown): number {
  return error instanceof SandboxRequestError ? error.status : 502;
}

/** サンドボックスの 4xx はそのまま、接続失敗は 502 にして応答する。 */
export function sandboxFailure(c: Context, error: unknown) {
  return c.json({ error: messageFor(error) }, sandboxFailureStatus(error) as ContentfulStatusCode);
}

type SettingsMutationOutcome<T> = { status: 200; response: T } | { status: 503; error: string };
type InvalidSettingsMutation = { status: 400; error: string };

type SettingsMutationResponse<T> =
  | (Response & TypedResponse<JSONParsed<T>, 200, "json">)
  | (Response & TypedResponse<{ error: string; state: "not_stored" }, 503, "json">);

// 400 を返せない更新処理もあるため、全ルートの AppType に 400 を載せない。
export function respondSettingsMutation<T extends object>(
  c: Context,
  outcome: SettingsMutationOutcome<T>,
): SettingsMutationResponse<T>;
export function respondSettingsMutation<T extends object>(
  c: Context,
  outcome: SettingsMutationOutcome<T> | InvalidSettingsMutation,
): SettingsMutationResponse<T> | (Response & TypedResponse<{ error: string }, 400, "json">);
export function respondSettingsMutation<T extends object>(
  c: Context,
  outcome: SettingsMutationOutcome<T> | InvalidSettingsMutation,
) {
  if (outcome.status === 503) return c.json({ error: outcome.error, state: "not_stored" as const }, 503);
  if (outcome.status === 400) return c.json({ error: outcome.error }, 400);
  return c.json(outcome.response, 200);
}

/** 本文は JSON に載せず、サンドボックスが決めた保存名と長さを改変しない。 */
export function relaySandboxDownload(c: Context, file: SandboxDownloadFile) {
  if (!file.body) return c.json({ error: "サンドボックスが本文を返しませんでした" }, 502);
  return c.body(file.body, 200, {
    "Content-Type": file.contentType,
    "Content-Disposition": file.contentDisposition,
    ...(file.contentLength === undefined ? {} : { "Content-Length": String(file.contentLength) }),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

/** 未設定時の案内。JSON と HTML の両方の応答で同じ文言を使う。 */
export const SANDBOX_NOT_CONFIGURED_MESSAGE = "サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)";

export function sandboxNotConfigured(c: Context) {
  return c.json({ error: SANDBOX_NOT_CONFIGURED_MESSAGE }, 503);
}
