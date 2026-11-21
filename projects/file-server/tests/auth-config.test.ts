import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createApp } from "../src/app"
import { getUsersFilePath } from "../src/utils/auth"
import { getSessionSecretFilePath } from "../src/utils/sessionSecret"
import { resetUsersCacheForTests } from "../src/utils/userConfigCache"
import { createTestApp } from "./helpers/createTestApp"
import { type PlainUser, writeUsersFile } from "./helpers/userStore"

const UPLOAD_DIR = "./tmp-test-auth-config"
const AUTH_DIR = path.join(UPLOAD_DIR, ".auth")
const SESSION_SECRET = "0123456789abcdef0123456789abcdef"

let app: Awaited<ReturnType<typeof createTestApp>>

const writeUsers = (users: PlainUser[]) => writeUsersFile(AUTH_DIR, users)

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
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
      initialAdminPassword: "initial-admin-pass",
    })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("reloads users when the users file changes", async () => {
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
  it("bootstraps admin on first startup with AUTH_DIR", async () => {
    const adminLogin = await login("admin", "initial-admin-pass")
    expect(adminLogin.status).toBe(302)
  })
  it("creates session-secret on first startup", async () => {
    const secret = await Bun.file(getSessionSecretFilePath(AUTH_DIR)).text()
    expect(secret.trim().length).toBeGreaterThan(0)
  })
  it("writes users.json with restricted permissions", async () => {
    const usersFile = getUsersFilePath(AUTH_DIR)
    const fileStat = await stat(usersFile)

    expect(fileStat.mode & 0o777).toBe(0o600)
  })
  it("keeps existing sessions valid after restart with the same AUTH_DIR", async () => {
    const adminLogin = await login("admin", "initial-admin-pass")
    const sessionCookie =
      adminLogin.headers.get("set-cookie")?.split(";")[0] ?? ""
    const originalSecret = await Bun.file(
      getSessionSecretFilePath(AUTH_DIR),
    ).text()

    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
    })

    const res = await app.request(
      new Request("http://localhost/?path=", {
        headers: { cookie: sessionCookie },
      }),
    )

    expect(res.status).toBe(200)
    await expect(
      Bun.file(getSessionSecretFilePath(AUTH_DIR)).text(),
    ).resolves.toBe(originalSecret)
  })
  it("fails to start if SESSION_SECRET is still set", async () => {
    process.env.SESSION_SECRET = SESSION_SECRET
    await expect(
      createApp({ uploadDir: UPLOAD_DIR, authDir: AUTH_DIR }),
    ).rejects.toThrow("SESSION_SECRET")
    delete process.env.SESSION_SECRET
  })
  it("fails to start if USERS_FILE is still set", async () => {
    process.env.USERS_FILE = "./legacy-users.json"
    await expect(
      createApp({ uploadDir: UPLOAD_DIR, authDir: AUTH_DIR }),
    ).rejects.toThrow("USERS_FILE")
    delete process.env.USERS_FILE
  })
  it("fails to start if users file exists but has no admin", async () => {
    const usersFile = getUsersFilePath(AUTH_DIR)
    await writeFile(
      usersFile,
      JSON.stringify([
        {
          username: "alice",
          passwordHash: "dummy",
          role: "user",
          sessionVersion: 0,
        },
      ]),
      "utf-8",
    )

    await expect(
      createTestApp({
        uploadDir: UPLOAD_DIR,
        authDir: AUTH_DIR,
        sessionSecret: SESSION_SECRET,
      }),
    ).rejects.toThrow()
  })
  it("rejects invalid username entries in users file", async () => {
    const usersFile = getUsersFilePath(AUTH_DIR)
    await writeFile(
      usersFile,
      JSON.stringify([
        {
          username: "alice/root",
          passwordHash: "dummy",
          role: "user",
          sessionVersion: 0,
        },
      ]),
      "utf-8",
    )
    resetUsersCacheForTests()

    const res = await app.request(new Request("http://localhost/login"))
    expect(res.status).toBe(500)
  })
  it("rejects invalid role entries in users file", async () => {
    const usersFile = getUsersFilePath(AUTH_DIR)
    await writeFile(
      usersFile,
      JSON.stringify([
        {
          username: "alice",
          passwordHash: "dummy",
          role: "super-admin",
          sessionVersion: 0,
        },
      ]),
      "utf-8",
    )
    resetUsersCacheForTests()

    const res = await app.request(new Request("http://localhost/login"))
    expect(res.status).toBe(500)
  })
  it("fails to start if users file contains broken JSON", async () => {
    const usersFile = getUsersFilePath(AUTH_DIR)
    await writeFile(usersFile, "{ broken json", "utf-8")

    await expect(
      createTestApp({
        uploadDir: UPLOAD_DIR,
        authDir: AUTH_DIR,
        sessionSecret: SESSION_SECRET,
      }),
    ).rejects.toThrow()
  })
  it("bootstraps admin when users file is empty (0 bytes)", async () => {
    const usersFile = getUsersFilePath(AUTH_DIR)
    await mkdir(path.dirname(usersFile), { recursive: true })
    await writeFile(usersFile, "", "utf-8")

    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
      initialAdminPassword: "initial-admin-pass",
    })

    const res = await login("admin", "initial-admin-pass")
    expect(res.status).toBe(302)
  })
  it("logs when INITIAL_ADMIN_PASSWORD is ignored for an existing admin", async () => {
    const messages: string[] = []
    const originalConsoleLog = console.log
    console.log = (...args: unknown[]) => {
      messages.push(args.join(" "))
    }

    try {
      app = await createTestApp({
        uploadDir: UPLOAD_DIR,
        authDir: AUTH_DIR,
        initialAdminPassword: "ignored-admin-pass",
      })
    } finally {
      console.log = originalConsoleLog
    }

    expect(messages).toContain(
      "[BOOTSTRAP] INITIAL_ADMIN_PASSWORD is ignored because users.json already contains a valid admin user.",
    )
  })
})
