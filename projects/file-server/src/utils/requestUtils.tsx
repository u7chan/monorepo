import type { Stats } from "node:fs"
import { stat as fsStat } from "node:fs/promises"
import type { Context } from "hono"
import { env } from "hono/adapter"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { HtmlEscapedString } from "hono/utils/html"
import { PageShell } from "../components/PageShell"
import { isInvalidPath } from "./fileUtils"

export function getUploadDir(c: Context): string {
  return env(c).UPLOAD_DIR || "./tmp"
}

export function getRequestPath(c: Context): string {
  return decodeURIComponent(c.req.query("path") || "")
}

export function isHtmxRequest(c: Context): boolean {
  return c.req.header("HX-Request") === "true"
}

export function errorResponse(
  c: Context,
  name: string,
  message: string,
  status: ContentfulStatusCode = 400,
) {
  return c.json(
    {
      success: false,
      error: { name, message },
    },
    status,
  )
}

export function invalidPathResponse(c: Context) {
  return errorResponse(c, "PathError", "Invalid path", 400)
}

export function ensureValidPath(
  c: Context,
  requestPath: string,
): Response | null {
  if (isInvalidPath(requestPath)) {
    return invalidPathResponse(c)
  }
  return null
}

export async function statOrNotFound(
  c: Context,
  resolvedPath: string,
  notFoundName: string,
  notFoundMessage: string,
): Promise<Stats | Response> {
  try {
    return await fsStat(resolvedPath)
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return errorResponse(c, notFoundName, notFoundMessage, 400)
    }
    throw err
  }
}

export function renderWithShell(
  c: Context,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) {
  if (isHtmxRequest(c)) {
    return c.html(body)
  }
  return c.html(<PageShell>{body}</PageShell>)
}
