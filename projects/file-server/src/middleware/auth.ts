import { mkdir } from "node:fs/promises"
import type { Context, Next } from "hono"
import { env } from "hono/adapter"
import { getCookie } from "hono/cookie"
import type { AppBindings } from "../types"
import {
  DEFAULT_UPLOAD_DIR,
  getUserUploadDir,
  loadUsersConfig,
  normalizeReturnTo,
  SESSION_COOKIE_NAME,
  validateAuthConfig,
  verifySession,
} from "../utils/auth"
import { errorResponse } from "../utils/requestUtils"

function getRequestPathWithQuery(c: Context<AppBindings>): string {
  const url = new URL(c.req.url)
  const pathWithQuery = `${url.pathname}${url.search}`
  return normalizeReturnTo(pathWithQuery)
}

function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/logout"
}

export async function authMiddleware(c: Context<AppBindings>, next: Next) {
  c.set("user", { type: "anonymous" })

  const { UPLOAD_DIR, USERS_FILE, SESSION_SECRET } = env(c)
  const uploadBaseDir = UPLOAD_DIR || DEFAULT_UPLOAD_DIR

  try {
    validateAuthConfig(USERS_FILE, SESSION_SECRET)
  } catch (error) {
    console.error(error)
    return errorResponse(
      c,
      "AuthConfigError",
      "Invalid authentication configuration",
      500,
    )
  }

  if (!USERS_FILE) {
    await mkdir(uploadBaseDir, { recursive: true })
    return next()
  }
  if (!SESSION_SECRET) {
    return errorResponse(
      c,
      "AuthConfigError",
      "SESSION_SECRET is required when USERS_FILE is set",
      500,
    )
  }

  let users: Awaited<ReturnType<typeof loadUsersConfig>> = null
  try {
    users = await loadUsersConfig(USERS_FILE)
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
  if (!session || !users) {
    return next()
  }

  const payload = await verifySession(session, SESSION_SECRET)
  if (!payload) {
    return next()
  }

  const user = users.find((entry) => entry.username === payload.username)
  if (!user) {
    return next()
  }

  const authenticated = {
    type: "authenticated" as const,
    username: user.username,
    role: user.role,
  }
  c.set("user", authenticated)
  await mkdir(getUserUploadDir(uploadBaseDir, authenticated), {
    recursive: true,
  })
  return next()
}

export async function requireAuthMiddleware(
  c: Context<AppBindings>,
  next: Next,
) {
  const { USERS_FILE } = env(c)
  if (!USERS_FILE) {
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
