import { Hono } from "hono"
import { env } from "hono/adapter"
import { deleteCookie, setCookie } from "hono/cookie"
import { PageShell } from "../components/PageShell"
import type { AppBindings } from "../types"
import {
	SESSION_COOKIE_NAME,
	SESSION_MAX_AGE_SECONDS,
	findUser,
	loadUsersConfig,
	normalizeReturnTo,
	signSession,
	verifyPassword,
} from "../utils/auth"

interface LoginPageProps {
	returnTo: string
	error?: string
	username?: string
}

function LoginPage({ returnTo, error, username }: LoginPageProps) {
	return (
		<div className="mx-auto max-w-md rounded-xl border border-indigo-200 bg-white p-6 shadow-sm">
			<h2 className="mb-1 text-xl font-semibold text-gray-900">Login</h2>
			<p className="mb-4 text-sm text-gray-600">
				Sign in to access your private files.
			</p>
			{error && (
				<div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
					{error}
				</div>
			)}
			<form action="/login" method="post" className="space-y-4">
				<input type="hidden" name="returnTo" value={returnTo} />
				<div>
					<label
						for="username"
						className="mb-1 block text-sm font-medium text-gray-700"
					>
						Username
					</label>
					<input
						id="username"
						name="username"
						type="text"
						required
						value={username}
						className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
					/>
				</div>
				<div>
					<label
						for="password"
						className="mb-1 block text-sm font-medium text-gray-700"
					>
						Password
					</label>
					<input
						id="password"
						name="password"
						type="password"
						required
						className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
					/>
				</div>
				<button
					type="submit"
					className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700"
				>
					Login
				</button>
			</form>
		</div>
	)
}

const authRoutes = new Hono<AppBindings>()

authRoutes.get("/login", (c) => {
	const usersFile = env(c).USERS_FILE
	if (!usersFile) {
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
	const { USERS_FILE, SESSION_SECRET } = env(c)
	if (!USERS_FILE) {
		return c.redirect("/")
	}
	if (!SESSION_SECRET) {
		return c.json(
			{
				success: false,
				error: {
					name: "AuthConfigError",
					message: "SESSION_SECRET is required when USERS_FILE is set",
				},
			},
			500,
		)
	}

	const formData = await c.req.formData()
	const username = String(formData.get("username") || "").trim()
	const password = String(formData.get("password") || "")
	const returnTo = normalizeReturnTo(String(formData.get("returnTo") || "/"))

	let users: Awaited<ReturnType<typeof loadUsersConfig>> = null
	try {
		users = await loadUsersConfig(USERS_FILE)
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
		{ username: matchedUser.username },
		SESSION_SECRET,
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
	const usersFile = env(c).USERS_FILE
	deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" })
	return c.redirect(usersFile ? "/login" : "/")
})

export default authRoutes
