import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import app from "../src/index"
import { validateAuthConfig } from "../src/utils/auth"
import { isPathTraversal } from "../src/utils/pathTraversal"
import { resetUsersCacheForTests } from "../src/utils/userConfigCache"
import { createTestSession } from "./helpers/auth"

const UPLOAD_DIR = "./tmp-test-auth"
const USERS_FILE = path.join(UPLOAD_DIR, "users.json")
const SESSION_SECRET = "0123456789abcdef0123456789abcdef"

type PlainUser = {
	username: string
	password: string
}

async function writeUsers(users: PlainUser[]) {
	const userConfigs = await Promise.all(
		users.map(async (user) => ({
			username: user.username,
			passwordHash: await Bun.password.hash(user.password, {
				algorithm: "bcrypt",
				cost: 4,
			}),
		})),
	)
	await writeFile(USERS_FILE, JSON.stringify(userConfigs), "utf-8")
}

async function login(
	username: string,
	password: string,
	returnTo = "/",
): Promise<Response> {
	const body = new URLSearchParams({ username, password, returnTo })
	return app.request(
		new Request("http://localhost/login", {
			method: "POST",
			body,
			headers: { "content-type": "application/x-www-form-urlencoded" },
			redirect: "manual",
		}),
	)
}

describe("auth", () => {
	beforeEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		await mkdir(UPLOAD_DIR, { recursive: true })
		process.env.UPLOAD_DIR = UPLOAD_DIR
		process.env.USERS_FILE = USERS_FILE
		process.env.SESSION_SECRET = SESSION_SECRET
		resetUsersCacheForTests()
	})

	afterEach(async () => {
		await rm(UPLOAD_DIR, { recursive: true, force: true })
		delete process.env.USERS_FILE
		delete process.env.SESSION_SECRET
		resetUsersCacheForTests()
	})

	it("allows access when authentication is disabled", async () => {
		delete process.env.USERS_FILE
		delete process.env.SESSION_SECRET

		const res = await app.request(
			new Request("http://localhost/?path=", {
				redirect: "manual",
			}),
		)

		expect(res.status).toBe(200)
	})

	it("redirects unauthenticated requests to login when auth is enabled", async () => {
		await writeUsers([{ username: "alice", password: "password1" }])

		const res = await app.request(
			new Request("http://localhost/?path=", {
				redirect: "manual",
			}),
		)

		expect(res.status).toBe(302)
		const location = res.headers.get("location")
		expect(location).toBe("/login?returnTo=%2F%3Fpath%3D")
	})

	it("sets a session cookie on successful login", async () => {
		await writeUsers([{ username: "alice", password: "password1" }])

		const res = await login("alice", "password1", "/?path=docs")

		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("/?path=docs")
		expect(res.headers.get("set-cookie")).toContain("session=")
	})

	it("returns 401 on failed login", async () => {
		await writeUsers([{ username: "alice", password: "password1" }])

		const res = await login("alice", "wrong-password")

		expect(res.status).toBe(401)
		const body = await res.text()
		expect(body).toContain("Invalid username or password")
	})

	it("isolates files by authenticated user directory", async () => {
		await writeUsers([
			{ username: "alice", password: "password1" },
			{ username: "bob", password: "password2" },
		])

		await mkdir(path.join(UPLOAD_DIR, "alice"), { recursive: true })
		await mkdir(path.join(UPLOAD_DIR, "bob"), { recursive: true })
		await writeFile(path.join(UPLOAD_DIR, "alice", "alice.txt"), "alice")
		await writeFile(path.join(UPLOAD_DIR, "bob", "bob.txt"), "bob")

		const aliceSession = await createTestSession("alice", SESSION_SECRET)
		const bobSession = await createTestSession("bob", SESSION_SECRET)

		const aliceRes = await app.request(
			new Request("http://localhost/api/", {
				headers: { cookie: aliceSession.cookie },
			}),
		)
		const bobRes = await app.request(
			new Request("http://localhost/api/", {
				headers: { cookie: bobSession.cookie },
			}),
		)

		const aliceJson = (await aliceRes.json()) as {
			files: Array<{ name: string }>
		}
		const bobJson = (await bobRes.json()) as {
			files: Array<{ name: string }>
		}

		expect(aliceRes.status).toBe(200)
		expect(bobRes.status).toBe(200)
		expect(aliceJson.files.map((file) => file.name)).toContain("alice.txt")
		expect(aliceJson.files.map((file) => file.name)).not.toContain("bob.txt")
		expect(bobJson.files.map((file) => file.name)).toContain("bob.txt")
		expect(bobJson.files.map((file) => file.name)).not.toContain("alice.txt")
	})

	it("rejects path traversal attempts for authenticated users", async () => {
		await writeUsers([{ username: "alice", password: "password1" }])
		const session = await createTestSession("alice", SESSION_SECRET)

		const res = await app.request(
			new Request("http://localhost/?path=../bob", {
				headers: { cookie: session.cookie },
			}),
		)

		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			success: boolean
			error: { name: string; message: string }
		}
		expect(body.success).toBe(false)
		expect(body.error.name).toBe("PathError")
	})

	it("clears the session cookie on logout", async () => {
		await writeUsers([{ username: "alice", password: "password1" }])
		const session = await createTestSession("alice", SESSION_SECRET)

		const res = await app.request(
			new Request("http://localhost/logout", {
				method: "POST",
				headers: { cookie: session.cookie },
				redirect: "manual",
			}),
		)

		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("/login")
		expect(res.headers.get("set-cookie")).toContain("session=;")
	})

	it("reloads users from USERS_FILE when file changes", async () => {
		await writeUsers([{ username: "alice", password: "oldpass" }])
		const oldLogin = await login("alice", "oldpass")
		expect(oldLogin.status).toBe(302)

		await new Promise((resolve) => setTimeout(resolve, 20))
		await writeUsers([{ username: "alice", password: "newpass" }])

		const rejectedOldLogin = await login("alice", "oldpass")
		const acceptedNewLogin = await login("alice", "newpass")

		expect(rejectedOldLogin.status).toBe(401)
		expect(acceptedNewLogin.status).toBe(302)
	})

	it("validates startup auth config requirements", () => {
		expect(() => validateAuthConfig("users.json", undefined)).toThrow(
			"SESSION_SECRET",
		)
	})

	it("handles precise path traversal checks", () => {
		expect(isPathTraversal("../../etc/passwd")).toBe(true)
		expect(isPathTraversal("../bob/file.txt")).toBe(true)
		expect(isPathTraversal("/etc/passwd")).toBe(true)
		expect(isPathTraversal("file..name.txt")).toBe(false)
		expect(isPathTraversal("docs..")).toBe(false)
		expect(isPathTraversal("")).toBe(false)
	})

	it("rejects invalid username entries in USERS_FILE", async () => {
		await writeFile(
			USERS_FILE,
			JSON.stringify([{ username: "alice/root", passwordHash: "dummy" }]),
			"utf-8",
		)

		const res = await app.request(new Request("http://localhost/login"))
		expect(res.status).toBe(500)
	})

	it("keeps file write access inside user directory", async () => {
		await writeUsers([{ username: "alice", password: "password1" }])
		const session = await createTestSession("alice", SESSION_SECRET)

		const formData = new FormData()
		formData.append("files", new File(["hello"], "safe.txt"))
		formData.append("path", "../../outside.txt")

		const res = await app.request(
			new Request("http://localhost/api/upload", {
				method: "POST",
				body: formData,
				headers: { cookie: session.cookie },
			}),
		)
		const body = (await res.json()) as {
			success: boolean
			failed: Array<{ reason: string }>
		}

		expect(res.status).toBe(200)
		expect(body.success).toBe(false)
		expect(body.failed[0]?.reason).toBe("Invalid path")
		const outsidePath = path.join(UPLOAD_DIR, "outside.txt")
		expect(Bun.file(outsidePath).exists()).resolves.toBe(false)
		const userFile = await readFile(path.join(UPLOAD_DIR, "alice"), {
			encoding: "utf-8",
		}).catch(() => "")
		expect(userFile).toBe("")
	})
})
