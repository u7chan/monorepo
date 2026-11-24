import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readBodyText } from "../bounded-body";
import { httpError, messageFor } from "../errors";
import { SANDBOX_MAX_BODY_BYTES } from "./protocol";

export function routeError(c: Context, error: unknown, fallbackStatus: 400 | 500) {
  const status = (error as { statusCode?: number }).statusCode ?? fallbackStatus;
  return c.json({ error: messageFor(error) }, status as ContentfulStatusCode);
}

export async function readRouteJson(
  c: Context,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    const text = await readBodyText(c.req.raw.body?.getReader(), SANDBOX_MAX_BODY_BYTES);
    if (text === undefined) throw httpError(413, "Request body is too large");
    const trimmed = text.trim();
    const parsed = trimmed ? (JSON.parse(trimmed) as unknown) : {};
    return { ok: true, body: parsed };
  } catch (error) {
    return { ok: false, response: routeError(c, error, 400) };
  }
}
