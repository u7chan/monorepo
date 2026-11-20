import type { Context } from "hono"
import { env } from "hono/adapter"
import type { HtmlEscapedString } from "hono/utils/html"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { PageShell } from "../components/PageShell"
import type { AppBindings, AuthenticatedUser, UserState } from "../types"
import {
  DEFAULT_UPLOAD_DIR,
  type ResolvedAuthConfig,
  type RuntimeAuthEnv,
  resolveAuthConfig,
} from "./auth"

const ANONYMOUS_USER: UserState = { type: "anonymous" }

/**
 * Why not read `c.get("user")` at each call site: authMiddleware always sets it,
 * but the fallback belongs to one place so a route mounted without the
 * middleware (tests, future routers) still resolves an identity.
 */
export function getUser(c: Context<AppBindings>): UserState {
  return c.get("user") ?? ANONYMOUS_USER
}

export function getAuthenticatedUser(
  c: Context<AppBindings>,
): AuthenticatedUser {
  const user = getUser(c)
  if (user.type !== "authenticated") {
    // Why not return a 401 response: this accessor is only reachable behind
    // requireAuthMiddleware, so reaching it anonymously means the route is
    // wired wrong and should fail loudly instead of looking like a user error.
    throw new Error("Authenticated user is required for this route.")
  }
  return user
}

export function getAuthConfig(c: Context<AppBindings>): ResolvedAuthConfig {
  return resolveAuthConfig(env(c) as RuntimeAuthEnv)
}

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

export function forbiddenResponse(c: Context<AppBindings>) {
  return errorResponse(c, "Forbidden", "Access denied", 403)
}

export function renderWithShell(
  c: Context<AppBindings>,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) {
  if (isHtmxRequest(c)) {
    return c.html(body)
  }
  return c.html(<PageShell user={getUser(c)}>{body}</PageShell>)
}
