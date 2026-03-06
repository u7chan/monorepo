import type { Stats } from "node:fs"
import { stat as fsStat } from "node:fs/promises"
import type { Context } from "hono"
import { env } from "hono/adapter"
import type { HtmlEscapedString } from "hono/utils/html"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { PageShell } from "../components/PageShell"
import type { AppBindings } from "../types"
import { getUserUploadDir } from "./auth"
import { isInvalidPath } from "./fileUtils"

/** Default upload directory when UPLOAD_DIR env var is not set */
export const DEFAULT_UPLOAD_DIR = "./tmp"

export function getUploadDir(c: Context<AppBindings>): string {
  const baseDir = env(c).UPLOAD_DIR || DEFAULT_UPLOAD_DIR
  const user = c.get("user") ?? { type: "anonymous" }
  return getUserUploadDir(baseDir, user)
}

export function getRequestPath(c: Context<AppBindings>): string {
  return decodeURIComponent(c.req.query("path") || "")
}

export function isHtmxRequest(c: Context<AppBindings>): boolean {
  return c.req.header("HX-Request") === "true"
}

export function errorResponse(
  c: Context<AppBindings>,
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

export function invalidPathResponse(c: Context<AppBindings>) {
  return errorResponse(c, "PathError", "Invalid path", 400)
}

export function ensureValidPath(
  c: Context<AppBindings>,
  requestPath: string,
): Response | null {
  if (isInvalidPath(requestPath)) {
    return invalidPathResponse(c)
  }
  return null
}

export async function statOrNotFound(
  c: Context<AppBindings>,
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
  c: Context<AppBindings>,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) {
  if (isHtmxRequest(c)) {
    return c.html(body)
  }
  return c.html(<PageShell user={c.get("user")}>{body}</PageShell>)
}
