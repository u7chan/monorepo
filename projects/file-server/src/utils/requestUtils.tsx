import type { Context } from "hono"
import { env } from "hono/adapter"
import type { HtmlEscapedString } from "hono/utils/html"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { PageShell } from "../components/PageShell"
import type { AppBindings } from "../types"
import { DEFAULT_UPLOAD_DIR } from "./auth"

export function getUploadDir(c: Context<AppBindings>): string {
  return env(c).UPLOAD_DIR || DEFAULT_UPLOAD_DIR
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

export function renderWithShell(
  c: Context<AppBindings>,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) {
  if (isHtmxRequest(c)) {
    return c.html(body)
  }
  return c.html(<PageShell user={c.get("user")}>{body}</PageShell>)
}
