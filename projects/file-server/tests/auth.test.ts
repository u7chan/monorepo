import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createApp } from "../src/app"
import { getSessionSecretFilePath, getUsersFilePath } from "../src/utils/auth"
import { isPathTraversal } from "../src/utils/pathTraversal"
import { resetUsersCacheForTests } from "../src/utils/userConfigCache"
import { createTestSession } from "./helpers/auth"
import { createTestApp } from "./helpers/createTestApp"

const UPLOAD_DIR = "./tmp-test-auth"
const AUTH_DIR = path.join(UPLOAD_DIR, ".auth")
const SESSION_SECRET = "0123456789abcdef0123456789abcdef"
const zipAvailable = Bun.spawnSync(["which", "zip"]).exitCode === 0

type PlainUser = {
  username: string
  password: string
  role?: "admin" | "user"
}

let app: Awaited<ReturnType<typeof createTestApp>>

async function writeUsers(users: PlainUser[]) {
  const usersFile = getUsersFilePath(AUTH_DIR)
  const userConfigs = await Promise.all(
    users.map(async (user) => ({
      username: user.username,
      passwordHash: await Bun.password.hash(user.password, {
        algorithm: "bcrypt",
        cost: 4,
      }),
      role: user.role ?? "user",
      sessionVersion: 0,
    })),
  )
  await mkdir(path.dirname(usersFile), { recursive: true })
  await writeFile(usersFile, JSON.stringify(userConfigs), "utf-8")
  resetUsersCacheForTests()
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

  it("allows access when authentication is disabled", async () => {
    app = await createTestApp({ uploadDir: UPLOAD_DIR })

    const res = await app.request(
      new Request("http://localhost/?path=", {
        redirect: "manual",
      }),
    )

    expect(res.status).toBe(200)
  })

  it("redirects unauthenticated requests to login when auth is enabled", async () => {
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

    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "alice.txt"),
      "alice",
    )
    await writeFile(path.join(UPLOAD_DIR, "private", "bob", "bob.txt"), "bob")

    const aliceSession = await createTestSession("alice", SESSION_SECRET)
    const bobSession = await createTestSession("bob", SESSION_SECRET)

    const aliceRes = await app.request(
      new Request("http://localhost/api/private/alice/", {
        headers: { cookie: aliceSession.cookie },
      }),
    )
    const bobRes = await app.request(
      new Request("http://localhost/api/private/bob/", {
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
    expect(aliceJson.files.map((f) => f.name)).toContain("alice.txt")
    expect(aliceJson.files.map((f) => f.name)).not.toContain("bob.txt")
    expect(bobJson.files.map((f) => f.name)).toContain("bob.txt")
    expect(bobJson.files.map((f) => f.name)).not.toContain("alice.txt")
  })

  it("allows admin to browse the whole upload root", async () => {
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2", role: "user" },
      { username: "bob", password: "password3", role: "user" },
    ])

    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "alice.txt"),
      "alice",
    )
    await writeFile(path.join(UPLOAD_DIR, "private", "bob", "bob.txt"), "bob")

    const adminSession = await createTestSession("admin", SESSION_SECRET)
    const res = await app.request(
      new Request("http://localhost/api/private/", {
        headers: { cookie: adminSession.cookie },
      }),
    )
    const body = (await res.json()) as {
      files: Array<{ name: string; type: "file" | "dir" }>
    }

    expect(res.status).toBe(200)
    expect(body.files).toEqual(
      expect.arrayContaining([
        { name: "alice", type: "dir" },
        { name: "bob", type: "dir" },
      ]),
    )
  })

  it("renders / as a home view for regular users", async () => {
    await writeUsers([{ username: "alice", password: "password1" }])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice", "docs"), {
      recursive: true,
    })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "notes.txt"),
      "hello",
    )

    const session = await createTestSession("alice", SESSION_SECRET)
    const res = await app.request(
      new Request("http://localhost/?path=", {
        headers: { cookie: session.cookie },
      }),
    )
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain(">home</a>")
    expect(text).toContain("Shared")
    expect(text).toContain('hx-get="/browse?path=public"')
    expect(text).toContain('hx-get="/browse?path=private%2Falice%2Fdocs"')
    expect(text).toContain('name="path" value="private/alice"')
    expect(text).toContain('href="/file/archive?path=private%2Falice"')
    expect(text).toContain("notes.txt")
  })

  it("keeps the home view after htmx create operations for regular users", async () => {
    await writeUsers([{ username: "alice", password: "password1" }])
    const session = await createTestSession("alice", SESSION_SECRET)

    const body = new URLSearchParams({
      path: "private/alice",
      file: "home.txt",
    })
    const res = await app.request(
      new Request("http://localhost/api/file", {
        method: "POST",
        body,
        headers: {
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "HX-Request": "true",
        },
      }),
    )
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain(">home</a>")
    expect(text).toContain("Shared")
    expect(text).toContain("home.txt")
    expect(text).toContain('name="path" value="private/alice"')
  })

  it("hides root action controls for admins", async () => {
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2", role: "user" },
    ])

    const session = await createTestSession("admin", SESSION_SECRET)
    const res = await app.request(
      new Request("http://localhost/?path=", {
        headers: { cookie: session.cookie },
      }),
    )
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain(">root</a>")
    expect(text).toContain("public")
    expect(text).toContain("private")
    expect(text).not.toContain("New File")
    expect(text).not.toContain("New Folder")
    expect(text).not.toContain("Download Zip")
  })

  it("allows admin to upload to another user's directory", async () => {
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "bob", password: "password2", role: "user" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })

    const adminSession = await createTestSession("admin", SESSION_SECRET)
    const formData = new FormData()
    formData.append("files", new File(["hello"], "from-admin.txt"))
    formData.append("path", "private/bob")

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
        headers: { cookie: adminSession.cookie },
      }),
    )

    expect(res.status).toBe(200)
    expect(
      Bun.file(
        path.join(UPLOAD_DIR, "private", "bob", "from-admin.txt"),
      ).text(),
    ).resolves.toBe("hello")
  })

  it("rejects path traversal attempts for authenticated users", async () => {
    await writeUsers([{ username: "alice", password: "password1" }])
    const session = await createTestSession("alice", SESSION_SECRET)

    const res = await app.request(
      new Request("http://localhost/?path=../bob", {
        headers: { cookie: session.cookie },
      }),
    )

    expect(res.status).toBe(403)
    const body = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(body.success).toBe(false)
    expect(body.error.name).toBe("Forbidden")
  })

  it("isolates archive downloads by authenticated user directory", async () => {
    if (!zipAvailable) {
      return
    }

    await writeUsers([
      { username: "alice", password: "password1" },
      { username: "bob", password: "password2" },
    ])

    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "alice.txt"),
      "alice",
    )
    await writeFile(path.join(UPLOAD_DIR, "private", "bob", "bob.txt"), "bob")

    const aliceSession = await createTestSession("alice", SESSION_SECRET)
    const res = await app.request(
      new Request("http://localhost/file/archive?path=private%2Falice", {
        headers: { cookie: aliceSession.cookie },
      }),
    )
    const bodyText = Buffer.from(await res.arrayBuffer()).toString("latin1")

    expect(res.status).toBe(200)
    expect(bodyText).toContain("alice.txt")
    expect(bodyText).not.toContain("bob.txt")
  })

  it("rejects archive traversal attempts for authenticated users", async () => {
    await writeUsers([{ username: "alice", password: "password1" }])
    const session = await createTestSession("alice", SESSION_SECRET)

    const res = await app.request(
      new Request("http://localhost/file/archive?path=..%2Fbob", {
        headers: { cookie: session.cookie },
      }),
    )
    const body = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }

    expect(res.status).toBe(403)
    expect(body.success).toBe(false)
    expect(body.error.name).toBe("Forbidden")
  })

  it("allows admin to archive another user's directory", async () => {
    if (!zipAvailable) {
      return
    }

    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2", role: "user" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "alice.txt"),
      "alice",
    )

    const adminSession = await createTestSession("admin", SESSION_SECRET)
    const res = await app.request(
      new Request("http://localhost/file/archive?path=private%2Falice", {
        headers: { cookie: adminSession.cookie },
      }),
    )
    const bodyText = Buffer.from(await res.arrayBuffer()).toString("latin1")

    expect(res.status).toBe(200)
    expect(bodyText).toContain("alice.txt")
  })

  it("rejects path traversal attempts for admins", async () => {
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
    ])
    const adminSession = await createTestSession("admin", SESSION_SECRET)

    const res = await app.request(
      new Request("http://localhost/?path=../etc", {
        headers: { cookie: adminSession.cookie },
      }),
    )
    const body = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }

    expect(res.status).toBe(403)
    expect(body.success).toBe(false)
    expect(body.error.name).toBe("Forbidden")
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

  it("handles precise path traversal checks", () => {
    expect(isPathTraversal("../../etc/passwd")).toBe(true)
    expect(isPathTraversal("../bob/file.txt")).toBe(true)
    expect(isPathTraversal("/etc/passwd")).toBe(true)
    expect(isPathTraversal("file..name.txt")).toBe(false)
    expect(isPathTraversal("docs..")).toBe(false)
    expect(isPathTraversal("")).toBe(false)
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

  it("invalidates session after sessionVersion mismatch", async () => {
    await writeUsers([{ username: "alice", password: "password1" }])

    const staleSession = await createTestSession("alice", SESSION_SECRET, 0)

    // Simulate version increment (e.g., password change)
    const usersFile = getUsersFilePath(AUTH_DIR)
    const userConfigs = [
      {
        username: "alice",
        passwordHash: await Bun.password.hash("newpass", {
          algorithm: "bcrypt",
          cost: 4,
        }),
        role: "user",
        sessionVersion: 1,
      },
    ]
    await writeFile(usersFile, JSON.stringify(userConfigs), "utf-8")
    resetUsersCacheForTests()

    const res = await app.request(
      new Request("http://localhost/?path=", {
        headers: { cookie: staleSession.cookie },
        redirect: "manual",
      }),
    )

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("/login")
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
      error: { name: string }
    }

    expect(res.status).toBe(403)
    expect(body.success).toBe(false)
    expect(body.error.name).toBe("Forbidden")
    const outsidePath = path.join(UPLOAD_DIR, "outside.txt")
    expect(Bun.file(outsidePath).exists()).resolves.toBe(false)
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

  it("blocks master admin password reset via /admin/users/:username/password", async () => {
    const adminSession = await createTestSession("admin", SESSION_SECRET)

    const body = new URLSearchParams({ newPassword: "hacked" })
    const res = await app.request(
      new Request("http://localhost/admin/users/admin/password", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: adminSession.cookie,
        },
        redirect: "manual",
      }),
    )

    expect(res.status).toBe(302)
    const location = res.headers.get("location") ?? ""
    expect(location).toContain("error")
    expect(location).toContain("master%20admin")
  })
})
