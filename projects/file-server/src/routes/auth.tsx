import { type Context, Hono } from "hono"
import { env } from "hono/adapter"
import { deleteCookie, setCookie } from "hono/cookie"
import { primaryButtonClassName } from "../components/buttonStyles"
import { PageShell } from "../components/PageShell"
import {
  alertErrorClassName,
  fieldClassName,
  labelClassName,
  mutedTextClassName,
} from "../components/uiStyles"
import type { AppBindings } from "../types"
import {
  findUser,
  loadSessionSecretWithCache,
  normalizeReturnTo,
  type RuntimeAuthEnv,
  resolveAuthConfig,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  signSession,
  verifyPassword,
} from "../utils/auth"
import { loadUsersFromFileWithCache } from "../utils/userConfigCache"

interface LoginPageProps {
  returnTo: string
  error?: string
  username?: string
}

function LoginPage({ returnTo, error, username }: LoginPageProps) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center py-8">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="text-lg font-semibold text-slate-900">Login</h2>
        <p className={`mt-1 mb-5 ${mutedTextClassName}`}>
          Sign in to access your private files.
        </p>
        {error && <div className={`mb-4 ${alertErrorClassName}`}>{error}</div>}
        <form action="/login" method="post" className="space-y-4">
          <input type="hidden" name="returnTo" value={returnTo} />
          <div>
            <label for="username" className={labelClassName}>
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              value={username}
              className={fieldClassName}
            />
          </div>
          <div>
            <label for="password" className={labelClassName}>
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type="password"
                required
                className={`${fieldClassName} pr-10`}
              />
              <button
                id="password-toggle"
                type="button"
                aria-label="Show password"
                aria-controls="password"
                aria-pressed="false"
                className="absolute inset-y-0 right-0 inline-flex w-10 cursor-pointer items-center justify-center text-slate-400 transition-colors hover:text-slate-600"
              >
                <span id="password-toggle-eye">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </span>
                <span id="password-toggle-eye-off" className="hidden">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M2.458 12C3.732 7.943 7.523 5 12 5c1.97 0 3.807.57 5.354 1.553" />
                    <path d="M21.542 12C20.268 16.057 16.477 19 12 19c-1.97 0-3.807-.57-5.354-1.553" />
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="m3 3 18 18" />
                  </svg>
                </span>
              </button>
            </div>
          </div>
          <button type="submit" className={`${primaryButtonClassName} w-full`}>
            Login
          </button>
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `
						(() => {
							const passwordInput = document.getElementById("password");
							const toggleButton = document.getElementById("password-toggle");
							const eye = document.getElementById("password-toggle-eye");
							const eyeOff = document.getElementById("password-toggle-eye-off");
							if (!passwordInput || !toggleButton || !eye || !eyeOff) {
								return;
							}
							toggleButton.addEventListener("click", () => {
								const showing = passwordInput.getAttribute("type") === "text";
								passwordInput.setAttribute("type", showing ? "password" : "text");
								toggleButton.setAttribute("aria-pressed", showing ? "false" : "true");
								toggleButton.setAttribute("aria-label", showing ? "Show password" : "Hide password");
								eye.classList.toggle("hidden", !showing);
								eyeOff.classList.toggle("hidden", showing);
							});
						})();
					`,
          }}
        />
      </div>
    </div>
  )
}

function getAuthConfig(c: Context<AppBindings>) {
  return resolveAuthConfig(env(c) as RuntimeAuthEnv)
}

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
    return c.json(
      {
        success: false,
        error: {
          name: "AuthConfigError",
          message: "Failed to load users configuration",
        },
      },
      500,
    )
  }

  let sessionSecret: string
  try {
    sessionSecret = await loadSessionSecretWithCache(authConfig.authDir)
  } catch (error) {
    console.error(error)
    return c.json(
      {
        success: false,
        error: {
          name: "AuthConfigError",
          message: "Failed to load session secret",
        },
      },
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
