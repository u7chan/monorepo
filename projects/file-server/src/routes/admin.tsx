import { type Context, Hono } from "hono"
import { setCookie } from "hono/cookie"
import { AdminUsersPage } from "../components/admin/AdminUsersPage"
import { PageShell } from "../components/PageShell"
import type { AppBindings, UserConfig } from "../types"
import {
  hashPassword,
  isValidUsername,
  MASTER_ADMIN_USERNAME,
  verifyPassword,
} from "../utils/auth"
import {
  getAuthConfig,
  getAuthenticatedUser,
  getUser,
} from "../utils/requestUtils"
import { loadSessionSecretWithCache } from "../utils/sessionSecret"
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  signSession,
} from "../utils/sessionToken"
import {
  loadUsersFromFileWithCache,
  saveUsersToFile,
} from "../utils/userConfigCache"

function redirectToUsers(
  c: Context<AppBindings>,
  status: "error" | "success",
  message: string,
) {
  return c.redirect(`/admin/users?${status}=${encodeURIComponent(message)}`)
}

type UsersLoadResult = { users: UserConfig[] } | { response: Response }

async function loadUsersOrError(
  c: Context<AppBindings>,
  usersFile: string,
): Promise<UsersLoadResult> {
  try {
    return { users: await loadUsersFromFileWithCache(usersFile) }
  } catch (error) {
    console.error(error)
    return { response: redirectToUsers(c, "error", "Failed to load users.") }
  }
}

function getUsersFile(c: Context<AppBindings>): string {
  const authConfig = getAuthConfig(c)
  if (!authConfig.usersFile) {
    throw new Error("Authentication is not enabled.")
  }
  return authConfig.usersFile
}

const adminRoutes = new Hono<AppBindings>()

adminRoutes.use("*", async (c, next) => {
  const user = c.get("user")
  if (user.type !== "authenticated" || user.role !== "admin") {
    if (c.req.header("HX-Request") === "true") {
      c.header("HX-Redirect", "/login")
      return c.body(null, 401)
    }
    return c.redirect("/login")
  }
  return next()
})

adminRoutes.get("/users", async (c) => {
  const usersFile = getUsersFile(c)
  const currentUser = getAuthenticatedUser(c)

  let users: UserConfig[] = []
  try {
    users = await loadUsersFromFileWithCache(usersFile)
  } catch (error) {
    console.error(error)
  }

  const error = c.req.query("error")
  const success = c.req.query("success")

  return c.html(
    <PageShell user={getUser(c)}>
      <AdminUsersPage
        users={users}
        currentUsername={currentUser.username}
        error={error}
        success={success}
      />
    </PageShell>,
  )
})

adminRoutes.post("/users", async (c) => {
  const usersFile = getUsersFile(c)

  const formData = await c.req.formData()
  const username = String(formData.get("username") || "").trim()
  const password = String(formData.get("password") || "")
  const role = String(formData.get("role") || "user")

  if (!isValidUsername(username)) {
    return redirectToUsers(
      c,
      "error",
      "Invalid username. Use only lowercase letters, numbers, hyphens, and underscores.",
    )
  }
  if (!password) {
    return redirectToUsers(c, "error", "Password is required.")
  }
  if (role !== "admin" && role !== "user") {
    return redirectToUsers(c, "error", "Invalid role.")
  }

  const loaded = await loadUsersOrError(c, usersFile)
  if ("response" in loaded) {
    return loaded.response
  }
  const users = loaded.users

  if (users.some((u) => u.username === username)) {
    return redirectToUsers(c, "error", `User '${username}' already exists.`)
  }

  const passwordHash = await hashPassword(password)

  await saveUsersToFile(usersFile, [
    ...users,
    {
      username,
      passwordHash,
      role: role as "admin" | "user",
      sessionVersion: 0,
    },
  ])

  return redirectToUsers(c, "success", `User '${username}' created.`)
})

adminRoutes.post("/users/:username/role", async (c) => {
  const usersFile = getUsersFile(c)
  const targetUsername = c.req.param("username")

  if (targetUsername === MASTER_ADMIN_USERNAME) {
    return redirectToUsers(c, "error", "Cannot change role of master admin.")
  }

  const formData = await c.req.formData()
  const newRole = String(formData.get("role") || "")
  if (newRole !== "admin" && newRole !== "user") {
    return redirectToUsers(c, "error", "Invalid role.")
  }

  const loaded = await loadUsersOrError(c, usersFile)
  if ("response" in loaded) {
    return loaded.response
  }
  const users = loaded.users

  const idx = users.findIndex((u) => u.username === targetUsername)
  if (idx === -1) {
    return redirectToUsers(c, "error", `User '${targetUsername}' not found.`)
  }

  const updated = users.map((u, i) =>
    i === idx
      ? {
          ...u,
          role: newRole as "admin" | "user",
          sessionVersion: u.sessionVersion + 1,
        }
      : u,
  )
  await saveUsersToFile(usersFile, updated)

  return redirectToUsers(
    c,
    "success",
    `Role of '${targetUsername}' changed to '${newRole}'.`,
  )
})

adminRoutes.post("/users/:username/delete", async (c) => {
  const usersFile = getUsersFile(c)
  const targetUsername = c.req.param("username")

  if (targetUsername === MASTER_ADMIN_USERNAME) {
    return redirectToUsers(c, "error", "Cannot delete master admin.")
  }

  const loaded = await loadUsersOrError(c, usersFile)
  if ("response" in loaded) {
    return loaded.response
  }
  const users = loaded.users

  const filtered = users.filter((u) => u.username !== targetUsername)
  if (filtered.length === users.length) {
    return redirectToUsers(c, "error", `User '${targetUsername}' not found.`)
  }

  await saveUsersToFile(usersFile, filtered)

  return redirectToUsers(c, "success", `User '${targetUsername}' deleted.`)
})

adminRoutes.post("/users/:username/password", async (c) => {
  const usersFile = getUsersFile(c)
  const targetUsername = c.req.param("username")
  const currentUser = getAuthenticatedUser(c)

  if (targetUsername === MASTER_ADMIN_USERNAME) {
    return redirectToUsers(
      c,
      "error",
      "Cannot reset master admin password via this endpoint. Use 'Change My Password'.",
    )
  }

  if (targetUsername === currentUser.username) {
    return redirectToUsers(
      c,
      "error",
      "Use 'Change My Password' to change your own password.",
    )
  }

  const formData = await c.req.formData()
  const newPassword = String(formData.get("newPassword") || "")
  if (!newPassword) {
    return redirectToUsers(c, "error", "New password is required.")
  }

  const loaded = await loadUsersOrError(c, usersFile)
  if ("response" in loaded) {
    return loaded.response
  }
  const users = loaded.users

  const idx = users.findIndex((u) => u.username === targetUsername)
  if (idx === -1) {
    return redirectToUsers(c, "error", `User '${targetUsername}' not found.`)
  }

  const newHash = await hashPassword(newPassword)
  const updated = users.map((u, i) =>
    i === idx
      ? { ...u, passwordHash: newHash, sessionVersion: u.sessionVersion + 1 }
      : u,
  )
  await saveUsersToFile(usersFile, updated)

  return redirectToUsers(
    c,
    "success",
    `Password of '${targetUsername}' has been reset.`,
  )
})

adminRoutes.post("/change-password", async (c) => {
  const authConfig = getAuthConfig(c)
  const usersFile = getUsersFile(c)
  const currentUser = getAuthenticatedUser(c)

  if (!authConfig.authDir) {
    return redirectToUsers(c, "error", "AuthConfigError")
  }

  const formData = await c.req.formData()
  const currentPassword = String(formData.get("currentPassword") || "")
  const newPassword = String(formData.get("newPassword") || "")

  if (!currentPassword || !newPassword) {
    return redirectToUsers(
      c,
      "error",
      "Both current and new password are required.",
    )
  }

  const loaded = await loadUsersOrError(c, usersFile)
  if ("response" in loaded) {
    return loaded.response
  }
  const users = loaded.users

  const self = users.find((u) => u.username === currentUser.username)
  if (!self) {
    return redirectToUsers(c, "error", "Current user not found.")
  }

  const valid = await verifyPassword(currentPassword, self.passwordHash)
  if (!valid) {
    return redirectToUsers(c, "error", "Current password is incorrect.")
  }

  const newHash = await hashPassword(newPassword)
  const newVersion = self.sessionVersion + 1
  const updated = users.map((u) =>
    u.username === currentUser.username
      ? { ...u, passwordHash: newHash, sessionVersion: newVersion }
      : u,
  )
  await saveUsersToFile(usersFile, updated)

  const sessionSecret = await loadSessionSecretWithCache(authConfig.authDir)
  const newSession = await signSession(
    { username: currentUser.username, sessionVersion: newVersion },
    sessionSecret,
  )
  setCookie(c, SESSION_COOKIE_NAME, newSession, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
  })

  return redirectToUsers(c, "success", "Password changed successfully.")
})

export default adminRoutes
