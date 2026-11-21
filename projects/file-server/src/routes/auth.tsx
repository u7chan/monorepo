import { Hono } from "hono"
import { deleteCookie, setCookie } from "hono/cookie"
import { LoginPage } from "../components/auth/LoginPage"
import { PageShell } from "../components/PageShell"
import type { AppBindings } from "../types"
import { findUser, normalizeReturnTo, verifyPassword } from "../utils/auth"
import { errorResponse, getAuthConfig } from "../utils/requestUtils"
import { loadSessionSecretWithCache } from "../utils/sessionSecret"
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  signSession,
} from "../utils/sessionToken"
import { loadUsersFromFileWithCache } from "../utils/userConfigCache"

const authRoutes = new Hono<AppBindings>()

authRoutes.get("/login", (c) => {
  const authConfig = getAuthConfig(c)
  if (!authConfig.enabled) {
    return c.redirect("/")
  }

  const user = c.get("user")
  const returnTo = normalizeReturnTo(c.req.query("returnTo"))
  if (user.type === "authenticated") {
    return c.redirect(returnTo)
  }

  const error = c.req.query("error")
  return c.html(
    <PageShell user={user}>
      <LoginPage returnTo={returnTo} error={error ?? undefined} />
    </PageShell>,
  )
})

authRoutes.post("/login", async (c) => {
  const authConfig = getAuthConfig(c)
  if (!authConfig.enabled || !authConfig.usersFile || !authConfig.authDir) {
    return c.redirect("/")
  }

  const formData = await c.req.formData()
  const username = String(formData.get("username") || "").trim()
  const password = String(formData.get("password") || "")
  const returnTo = normalizeReturnTo(String(formData.get("returnTo") || "/"))

  let users: Awaited<ReturnType<typeof loadUsersFromFileWithCache>> | null =
    null
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

  let sessionSecret: string
  try {
    sessionSecret = await loadSessionSecretWithCache(authConfig.authDir)
  } catch (error) {
    console.error(error)
    return errorResponse(
      c,
      "AuthConfigError",
      "Failed to load session secret",
      500,
    )
  }

  const matchedUser = findUser(users, username)
  const isValidPassword = matchedUser
    ? await verifyPassword(password, matchedUser.passwordHash)
    : false

  if (!matchedUser || !isValidPassword) {
    return c.html(
      <PageShell user={{ type: "anonymous" }}>
        <LoginPage
          returnTo={returnTo}
          error="Invalid username or password"
          username={username}
        />
      </PageShell>,
      401,
    )
  }

  const sessionValue = await signSession(
    {
      username: matchedUser.username,
      sessionVersion: matchedUser.sessionVersion,
    },
    sessionSecret,
  )
  setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
  })

  return c.redirect(returnTo)
})

authRoutes.post("/logout", (c) => {
  const authConfig = getAuthConfig(c)
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" })
  return c.redirect(authConfig.enabled ? "/login" : "/")
})

export default authRoutes
