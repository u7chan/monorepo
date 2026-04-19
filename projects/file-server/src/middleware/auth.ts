import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import type { Context, Next } from "hono"
import { env } from "hono/adapter"
import { getCookie } from "hono/cookie"
import type { AppBindings } from "../types"
import {
  DEFAULT_UPLOAD_DIR,
  loadSessionSecretWithCache,
  normalizeReturnTo,
  type ResolvedAuthConfig,
  type RuntimeAuthEnv,
  resolveAuthConfig,
  SESSION_COOKIE_NAME,
  verifySession,
} from "../utils/auth"
import { errorResponse } from "../utils/requestUtils"
import { loadUsersFromFileWithCache } from "../utils/userConfigCache"

function getRequestPathWithQuery(c: Context<AppBindings>): string {
  const url = new URL(c.req.url)
  const pathWithQuery = `${url.pathname}${url.search}`
  return normalizeReturnTo(pathWithQuery)
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/logout" ||
    pathname.startsWith("/public/") ||
    pathname === "/public"
  )
}

export async function authMiddleware(c: Context<AppBindings>, next: Next) {
  c.set("user", { type: "anonymous" })

  const runtimeEnv = env(c) as RuntimeAuthEnv
  const { UPLOAD_DIR } = runtimeEnv
  const uploadBaseDir = UPLOAD_DIR || DEFAULT_UPLOAD_DIR
  const authConfig: ResolvedAuthConfig = resolveAuthConfig(runtimeEnv)

  if (!authConfig.enabled || !authConfig.usersFile || !authConfig.authDir) {
    return next()
  }

  let users: Awaited<ReturnType<typeof loadUsersFromFileWithCache>>
  try {
    users = await loadUsersFromFileWithCache(authConfig.usersFile)
  } catch (error) {
    console.error(error)
    return errorResponse(
      c,
      "AuthConfigError",
      "Failed to load users configuration",
      500,
    )
  }

  const session = getCookie(c, SESSION_COOKIE_NAME)
  if (!session) {
    return next()
  }

  let payload: Awaited<ReturnType<typeof verifySession>>
  try {
    const sessionSecret = await loadSessionSecretWithCache(authConfig.authDir)
    payload = await verifySession(session, sessionSecret)
  } catch (error) {
    console.error(error)
    return errorResponse(
      c,
      "AuthConfigError",
      "Failed to load session secret",
      500,
    )
  }
  if (!payload) {
    return next()
  }

  const user = users.find((entry) => entry.username === payload.username)
  if (!user) {
    return next()
  }

  if (user.sessionVersion !== payload.sessionVersion) {
    return next()
  }

  const authenticated = {
    type: "authenticated" as const,
    username: user.username,
    role: user.role,
  }
  c.set("user", authenticated)

  if (authenticated.role === "user") {
    await mkdir(path.join(uploadBaseDir, "private", authenticated.username), {
      recursive: true,
    })
  }

  return next()
}

export async function requireAuthMiddleware(
  c: Context<AppBindings>,
  next: Next,
) {
  const runtimeEnv = env(c) as RuntimeAuthEnv
  const authConfig: ResolvedAuthConfig = resolveAuthConfig(runtimeEnv)

  if (!authConfig.enabled) {
    return next()
  }

  if (isPublicPath(c.req.path)) {
    return next()
  }

  const user = c.get("user")
  if (user.type === "authenticated") {
    return next()
  }

  const returnTo = encodeURIComponent(getRequestPathWithQuery(c))
  const loginUrl = `/login?returnTo=${returnTo}`

  if (c.req.header("HX-Request") === "true") {
    c.header("HX-Redirect", loginUrl)
    return c.body(null, 401)
  }

  return c.redirect(loginUrl)
}
