import { type Context, Hono } from "hono"
import { env } from "hono/adapter"
import { setCookie } from "hono/cookie"
import {
  compactDangerButtonClassName,
  compactSecondaryButtonClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from "../components/buttonStyles"
import { PageShell } from "../components/PageShell"
import {
  alertErrorClassName,
  alertSuccessClassName,
  compactFieldClassName,
  fieldClassName,
  labelClassName,
  sectionClassName,
  sectionTitleClassName,
} from "../components/uiStyles"
import type { AppBindings, UserConfig } from "../types"
import {
  isValidUsername,
  loadSessionSecretWithCache,
  MASTER_ADMIN_USERNAME,
  type RuntimeAuthEnv,
  resolveAuthConfig,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  signSession,
  verifyPassword,
} from "../utils/auth"
import {
  loadUsersFromFileWithCache,
  saveUsersToFile,
} from "../utils/userConfigCache"

interface AdminUsersPageProps {
  users: UserConfig[]
  currentUsername: string
  error?: string
  success?: string
}

function AdminUsersPage({
  users,
  currentUsername,
  error,
  success,
}: AdminUsersPageProps) {
  return (
    <div className="space-y-8 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          User Management
        </h2>
        <a href="/" className={secondaryButtonClassName}>
          ← Back
        </a>
      </div>

      {error && <div className={alertErrorClassName}>{error}</div>}
      {success && <div className={alertSuccessClassName}>{success}</div>}

      <section className={sectionClassName}>
        <h3 className={`mb-3 ${sectionTitleClassName}`}>Change My Password</h3>
        <form
          action="/admin/change-password"
          method="post"
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-36 max-w-sm flex-1">
            <label for="change-current-password" className={labelClassName}>
              Current password
            </label>
            <input
              id="change-current-password"
              name="currentPassword"
              type="password"
              required
              className={fieldClassName}
            />
          </div>
          <div className="min-w-36 max-w-sm flex-1">
            <label for="change-new-password" className={labelClassName}>
              New password
            </label>
            <input
              id="change-new-password"
              name="newPassword"
              type="password"
              required
              className={fieldClassName}
            />
          </div>
          <button type="submit" className={primaryButtonClassName}>
            Change
          </button>
        </form>
      </section>

      <section className={sectionClassName}>
        <h3 className={`mb-3 ${sectionTitleClassName}`}>Users</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
                <th className="pr-4 pb-2">Username</th>
                <th className="pr-4 pb-2">Role</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((user) => (
                <tr key={user.username}>
                  <td className="py-3 pr-4 font-medium text-slate-800">
                    {user.username}
                    {user.username === currentUsername && (
                      <span className="ml-2 text-xs text-slate-400">(you)</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-slate-600">{user.role}</td>
                  <td className="py-3">
                    {user.username === MASTER_ADMIN_USERNAME ? (
                      <span className="text-xs text-slate-400">Protected</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <form
                          action={`/admin/users/${user.username}/role`}
                          method="post"
                          className="flex items-center gap-2"
                        >
                          <select
                            name="role"
                            aria-label={`Role for ${user.username}`}
                            className={compactFieldClassName}
                          >
                            <option
                              value="user"
                              selected={user.role === "user"}
                            >
                              user
                            </option>
                            <option
                              value="admin"
                              selected={user.role === "admin"}
                            >
                              admin
                            </option>
                          </select>
                          <button
                            type="submit"
                            className={compactSecondaryButtonClassName}
                          >
                            Change Role
                          </button>
                        </form>
                        {user.username !== currentUsername && (
                          <form
                            action={`/admin/users/${user.username}/password`}
                            method="post"
                            className="flex items-center gap-2"
                          >
                            <input
                              name="newPassword"
                              type="password"
                              required
                              placeholder="New password"
                              aria-label={`New password for ${user.username}`}
                              className={compactFieldClassName}
                            />
                            <button
                              type="submit"
                              className={compactSecondaryButtonClassName}
                            >
                              Reset PW
                            </button>
                          </form>
                        )}
                        <form
                          action={`/admin/users/${user.username}/delete`}
                          method="post"
                        >
                          <button
                            type="submit"
                            className={compactDangerButtonClassName}
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={sectionClassName}>
        <h3 className={`mb-3 ${sectionTitleClassName}`}>Create User</h3>
        <form
          action="/admin/users"
          method="post"
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-32 max-w-sm flex-1">
            <label for="create-username" className={labelClassName}>
              Username
            </label>
            <input
              id="create-username"
              name="username"
              type="text"
              required
              className={fieldClassName}
            />
          </div>
          <div className="min-w-32 max-w-sm flex-1">
            <label for="create-password" className={labelClassName}>
              Password
            </label>
            <input
              id="create-password"
              name="password"
              type="password"
              required
              className={fieldClassName}
            />
          </div>
          <div>
            <label for="create-role" className={labelClassName}>
              Role
            </label>
            <select id="create-role" name="role" className={fieldClassName}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button type="submit" className={primaryButtonClassName}>
            Create User
          </button>
        </form>
      </section>
    </div>
  )
}

function getAuthConfig(c: Context<AppBindings>) {
  return resolveAuthConfig(env(c) as RuntimeAuthEnv)
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
  const currentUser = c.get("user") as Extract<
    typeof c.var.user,
    { type: "authenticated" }
  >

  let users: UserConfig[] = []
  try {
    users = await loadUsersFromFileWithCache(usersFile)
  } catch (error) {
    console.error(error)
  }

  const error = c.req.query("error")
  const success = c.req.query("success")

  return c.html(
    <PageShell user={c.get("user")}>
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
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Invalid username. Use only lowercase letters, numbers, hyphens, and underscores.")}`,
    )
  }
  if (!password) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Password is required.")}`,
    )
  }
  if (role !== "admin" && role !== "user") {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Invalid role.")}`,
    )
  }

  let users: UserConfig[] = []
  try {
    users = await loadUsersFromFileWithCache(usersFile)
  } catch (error) {
    console.error(error)
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Failed to load users.")}`,
    )
  }

  if (users.some((u) => u.username === username)) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent(`User '${username}' already exists.`)}`,
    )
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 12,
  })

  await saveUsersToFile(usersFile, [
    ...users,
    {
      username,
      passwordHash,
      role: role as "admin" | "user",
      sessionVersion: 0,
    },
  ])

  return c.redirect(
    `/admin/users?success=${encodeURIComponent(`User '${username}' created.`)}`,
  )
})

adminRoutes.post("/users/:username/role", async (c) => {
  const usersFile = getUsersFile(c)
  const targetUsername = c.req.param("username")

  if (targetUsername === MASTER_ADMIN_USERNAME) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Cannot change role of master admin.")}`,
    )
  }

  const formData = await c.req.formData()
  const newRole = String(formData.get("role") || "")
  if (newRole !== "admin" && newRole !== "user") {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Invalid role.")}`,
    )
  }

  let users: UserConfig[] = []
  try {
    users = await loadUsersFromFileWithCache(usersFile)
  } catch (error) {
    console.error(error)
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Failed to load users.")}`,
    )
  }

  const idx = users.findIndex((u) => u.username === targetUsername)
  if (idx === -1) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent(`User '${targetUsername}' not found.`)}`,
    )
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

  return c.redirect(
    `/admin/users?success=${encodeURIComponent(`Role of '${targetUsername}' changed to '${newRole}'.`)}`,
  )
})

adminRoutes.post("/users/:username/delete", async (c) => {
  const usersFile = getUsersFile(c)
  const targetUsername = c.req.param("username")

  if (targetUsername === MASTER_ADMIN_USERNAME) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Cannot delete master admin.")}`,
    )
  }

  let users: UserConfig[] = []
  try {
    users = await loadUsersFromFileWithCache(usersFile)
  } catch (error) {
    console.error(error)
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Failed to load users.")}`,
    )
  }

  const filtered = users.filter((u) => u.username !== targetUsername)
  if (filtered.length === users.length) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent(`User '${targetUsername}' not found.`)}`,
    )
  }

  await saveUsersToFile(usersFile, filtered)

  return c.redirect(
    `/admin/users?success=${encodeURIComponent(`User '${targetUsername}' deleted.`)}`,
  )
})

adminRoutes.post("/users/:username/password", async (c) => {
  const usersFile = getUsersFile(c)
  const targetUsername = c.req.param("username")
  const currentUser = c.get("user") as Extract<
    typeof c.var.user,
    { type: "authenticated" }
  >

  if (targetUsername === MASTER_ADMIN_USERNAME) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Cannot reset master admin password via this endpoint. Use 'Change My Password'.")}`,
    )
  }

  if (targetUsername === currentUser.username) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Use 'Change My Password' to change your own password.")}`,
    )
  }

  const formData = await c.req.formData()
  const newPassword = String(formData.get("newPassword") || "")
  if (!newPassword) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("New password is required.")}`,
    )
  }

  let users: UserConfig[] = []
  try {
    users = await loadUsersFromFileWithCache(usersFile)
  } catch (error) {
    console.error(error)
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Failed to load users.")}`,
    )
  }

  const idx = users.findIndex((u) => u.username === targetUsername)
  if (idx === -1) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent(`User '${targetUsername}' not found.`)}`,
    )
  }

  const newHash = await Bun.password.hash(newPassword, {
    algorithm: "bcrypt",
    cost: 12,
  })
  const updated = users.map((u, i) =>
    i === idx
      ? { ...u, passwordHash: newHash, sessionVersion: u.sessionVersion + 1 }
      : u,
  )
  await saveUsersToFile(usersFile, updated)

  return c.redirect(
    `/admin/users?success=${encodeURIComponent(`Password of '${targetUsername}' has been reset.`)}`,
  )
})

adminRoutes.post("/change-password", async (c) => {
  const authConfig = getAuthConfig(c)
  const usersFile = getUsersFile(c)
  const currentUser = c.get("user") as Extract<
    typeof c.var.user,
    { type: "authenticated" }
  >

  if (!authConfig.authDir) {
    return c.redirect("/admin/users?error=AuthConfigError")
  }

  const formData = await c.req.formData()
  const currentPassword = String(formData.get("currentPassword") || "")
  const newPassword = String(formData.get("newPassword") || "")

  if (!currentPassword || !newPassword) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Both current and new password are required.")}`,
    )
  }

  let users: UserConfig[] = []
  try {
    users = await loadUsersFromFileWithCache(usersFile)
  } catch (error) {
    console.error(error)
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Failed to load users.")}`,
    )
  }

  const self = users.find((u) => u.username === currentUser.username)
  if (!self) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Current user not found.")}`,
    )
  }

  const valid = await verifyPassword(currentPassword, self.passwordHash)
  if (!valid) {
    return c.redirect(
      `/admin/users?error=${encodeURIComponent("Current password is incorrect.")}`,
    )
  }

  const newHash = await Bun.password.hash(newPassword, {
    algorithm: "bcrypt",
    cost: 12,
  })
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

  return c.redirect(
    `/admin/users?success=${encodeURIComponent("Password changed successfully.")}`,
  )
})

export default adminRoutes
