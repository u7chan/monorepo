import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { getUsersFilePath } from "../src/utils/auth"
import { resetUsersCacheForTests } from "../src/utils/userConfigCache"
import { createTestSession } from "./helpers/auth"
import { createTestApp } from "./helpers/createTestApp"

const UPLOAD_DIR = "./tmp-test-move"
const AUTH_DIR = path.join(UPLOAD_DIR, ".auth")
const SESSION_SECRET = "0123456789abcdef0123456789abcdef"
let app: Awaited<ReturnType<typeof createTestApp>>

type PlainUser = { username: string; password: string; role?: "admin" | "user" }

async function writeUsers(users: PlainUser[]) {
  const usersFile = getUsersFilePath(AUTH_DIR)
  const userConfigs = await Promise.all(
    users.map(async (u) => ({
      username: u.username,
      passwordHash: await Bun.password.hash(u.password, {
        algorithm: "bcrypt",
        cost: 4,
      }),
      role: u.role ?? "user",
      sessionVersion: 0,
    })),
  )
  await mkdir(path.dirname(usersFile), { recursive: true })
  await writeFile(usersFile, JSON.stringify(userConfigs), "utf-8")
  resetUsersCacheForTests()
}

async function postMove(
  body: URLSearchParams,
  extraHeaders: Record<string, string> = {},
) {
  return app.request(
    new Request("http://localhost/api/move", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...extraHeaders,
      },
    }),
  )
}

beforeEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
  app = await createTestApp({ uploadDir: UPLOAD_DIR })
})

afterEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
})

describe("POST /api/move", () => {
  it("moves a file within public to another subdirectory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "dst"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "public/dst",
    })
    const res = await postMove(body)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=public")
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "public", "dst", "src.txt"),
        "utf-8",
      ),
    ).toBe("hello")
    expect(
      Bun.file(path.join(UPLOAD_DIR, "public", "src.txt")).text(),
    ).rejects.toThrow()
  })

  it("moves a folder with contents into another public directory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "dst"), { recursive: true })
    await mkdir(path.join(UPLOAD_DIR, "public", "src-dir"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "public", "src-dir", "inside.txt"),
      "payload",
    )

    const body = new URLSearchParams({
      path: "public/src-dir",
      destination: "public/dst",
    })
    const res = await postMove(body)
    expect(res.status).toBe(301)
    expect(
      await stat(path.join(UPLOAD_DIR, "public", "dst", "src-dir")),
    ).toMatchObject({ isDirectory: expect.any(Function) })
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "public", "dst", "src-dir", "inside.txt"),
        "utf-8",
      ),
    ).toBe("payload")
    expect(
      Bun.file(path.join(UPLOAD_DIR, "public", "src-dir", "inside.txt")).text(),
    ).rejects.toThrow()
  })

  it("returns DestNotFound when destination directory does not exist", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "public/missing-dir",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("DestNotFound")
  })

  it("returns DestNotDirectory when destination is a file", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")
    await writeFile(path.join(UPLOAD_DIR, "public", "already.txt"), "other")

    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "public/already.txt",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("DestNotDirectory")
  })

  it("returns AlreadyExists when a same-name entry is present at destination", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "dst"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")
    await writeFile(
      path.join(UPLOAD_DIR, "public", "dst", "src.txt"),
      "blocking",
    )

    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "public/dst",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("AlreadyExists")
    expect(json.error.message).toBe('"src.txt" already exists.')
  })

  it("rejects path traversal in source", async () => {
    const body = new URLSearchParams({
      path: "../bad",
      destination: "public",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("PathError")
  })

  it("rejects path traversal in destination", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")
    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "public/../private",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("PathError")
  })

  it("moves a file from public to private when auth is disabled", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "private",
    })
    const res = await postMove(body)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=public")
    expect(
      await readFile(path.join(UPLOAD_DIR, "private", "src.txt"), "utf-8"),
    ).toBe("hello")
  })

  it("moves a folder with contents from private to public when auth is disabled", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private", "inventory", "src-dir"), {
      recursive: true,
    })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "inventory", "src-dir", "inside.txt"),
      "payload",
    )

    const body = new URLSearchParams({
      path: "private/inventory/src-dir",
      destination: "public",
    })
    const res = await postMove(body)
    expect(res.status).toBe(301)
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "public", "src-dir", "inside.txt"),
        "utf-8",
      ),
    ).toBe("payload")
    expect(
      Bun.file(
        path.join(UPLOAD_DIR, "private", "inventory", "src-dir"),
      ).exists(),
    ).resolves.toBe(false)
  })

  it("rejects moving a scope root across scopes", async () => {
    for (const [source, destination] of [
      ["public", "private"],
      ["private", "public"],
    ]) {
      const body = new URLSearchParams({ path: source, destination })
      const res = await postMove(body)
      expect(res.status).toBe(400)
      const json = (await res.json()) as {
        success: boolean
        error: { name: string }
      }
      expect(json.error.name).toBe("InvalidSource")
    }
  })

  it("rejects moving a top-level private entry across scopes when auth is disabled", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private", "home-like"), {
      recursive: true,
    })

    const body = new URLSearchParams({
      path: "private/home-like",
      destination: "public",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("InvalidSource")
  })

  it("rejects moving a directory into itself", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "foo"), { recursive: true })

    const body = new URLSearchParams({
      path: "public/foo",
      destination: "public/foo",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("InvalidDestination")
  })

  it("rejects moving a directory into its own subdirectory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "foo", "bar"), {
      recursive: true,
    })

    const body = new URLSearchParams({
      path: "public/foo",
      destination: "public/foo/bar",
    })
    const res = await postMove(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("InvalidDestination")
  })

  it("returns updated HTML via htmx", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "dst"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "public/dst",
    })
    const res = await postMove(body, { "HX-Request": "true" })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("src.txt")
    expect(text).not.toContain("<html")
  })

  it("pre-renders Move controls in the browse view", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "browse-test.txt"), "c")

    const res = await app.request(new Request("http://localhost/?path=public"))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('aria-label="Move"')
    expect(text).toContain("/api/move/picker?source=")
    expect(text).toContain('id="move-picker-container"')
  })

  it("allows a regular user to move within their own private scope", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([{ username: "alice", password: "password1" }])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice", "dst"), {
      recursive: true,
    })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "src.txt"),
      "mine",
    )

    const session = await createTestSession("alice", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice/src.txt",
      destination: "private/alice/dst",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(301)
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "private", "alice", "dst", "src.txt"),
        "utf-8",
      ),
    ).toBe("mine")
  })

  it("rejects regular user moving into another user's private area", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "alice", password: "password1" },
      { username: "bob", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "src.txt"),
      "mine",
    )

    const session = await createTestSession("alice", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice/src.txt",
      destination: "private/bob",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(403)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("Forbidden")
  })

  it("allows admin to move between users within private scope", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2" },
      { username: "bob", password: "password3" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "src.txt"),
      "secret",
    )

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice/src.txt",
      destination: "private/bob",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(301)
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "private", "bob", "src.txt"),
        "utf-8",
      ),
    ).toBe("secret")
  })

  it("allows admin to move a file from public into their own home", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2" },
    ])
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "private/admin",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(301)
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "private", "admin", "src.txt"),
        "utf-8",
      ),
    ).toBe("hello")
  })

  it("allows admin to move a file from their own home into public", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "admin"), {
      recursive: true,
    })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "admin", "mine.txt"),
      "mine",
    )

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/admin/mine.txt",
      destination: "public",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(301)
    expect(
      await readFile(path.join(UPLOAD_DIR, "public", "mine.txt"), "utf-8"),
    ).toBe("mine")
  })

  it("rejects admin moving public into another user's home with CrossUser", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "private/alice",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(403)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("CrossUser")
    expect(json.error.message).toBe("Cannot move across user boundaries")
  })

  it("rejects admin moving another user's file into public with CrossUser", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "src.txt"),
      "secret",
    )

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice/src.txt",
      destination: "public",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(403)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("CrossUser")
  })

  it("rejects admin moving a home root across scopes", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice",
      destination: "public",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("InvalidSource")
  })

  it("keeps admin able to move a home root within private scope", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2" },
      { username: "bob", password: "password3" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "inside.txt"),
      "payload",
    )
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice",
      destination: "private/bob",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(301)
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "private", "bob", "alice", "inside.txt"),
        "utf-8",
      ),
    ).toBe("payload")
  })

  it("allows a regular user to move a file from public into their own home", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([{ username: "alice", password: "password1" }])
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const session = await createTestSession("alice", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "private/alice",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(301)
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "private", "alice", "src.txt"),
        "utf-8",
      ),
    ).toBe("hello")
  })

  it("allows a regular user to move a file from their own home into public", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([{ username: "alice", password: "password1" }])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), {
      recursive: true,
    })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "mine.txt"),
      "mine",
    )

    const session = await createTestSession("alice", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice/mine.txt",
      destination: "public",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(301)
    expect(
      await readFile(path.join(UPLOAD_DIR, "public", "mine.txt"), "utf-8"),
    ).toBe("mine")
  })

  it("rejects a regular user moving public into another user's home", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "alice", password: "password1" },
      { username: "bob", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const session = await createTestSession("alice", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "public/src.txt",
      destination: "private/bob",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(403)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("Forbidden")
  })

  it("rejects a regular user moving another user's file into public", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "alice", password: "password1" },
      { username: "bob", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "private", "bob", "x.txt"), "x")

    const session = await createTestSession("alice", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/bob/x.txt",
      destination: "public",
    })
    const res = await postMove(body, { cookie: session.cookie })
    expect(res.status).toBe(403)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(json.error.name).toBe("Forbidden")
  })
})

describe("GET /api/move/picker", () => {
  it("returns the picker modal scoped to the source's directory tree", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "a"), { recursive: true })
    await mkdir(path.join(UPLOAD_DIR, "public", "b"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const res = await app.request(
      new Request("http://localhost/api/move/picker?source=public%2Fsrc.txt"),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("data-move-picker-modal")
    expect(text).toContain("a/")
    expect(text).toContain("b/")
    expect(text).toContain('hx-post="/api/move"')
    expect(text).toContain('name="path"')
    expect(text).toContain('value="public/src.txt"')
  })

  it("confines a regular user's picker to their own private scope", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "alice", password: "password1" },
      { username: "bob", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice", "inbox"), {
      recursive: true,
    })
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "src.txt"),
      "mine",
    )

    const session = await createTestSession("alice", SESSION_SECRET)
    const res = await app.request(
      new Request(
        "http://localhost/api/move/picker?source=private%2Falice%2Fsrc.txt",
        { headers: { cookie: session.cookie } },
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("inbox/")
    expect(text).not.toContain("bob/")
  })

  it("rejects picker access when the source is outside the user's scope", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([{ username: "alice", password: "password1" }])
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "private", "bob", "x.txt"), "x")

    const session = await createTestSession("alice", SESSION_SECRET)
    const res = await app.request(
      new Request(
        "http://localhost/api/move/picker?source=private%2Fbob%2Fx.txt",
        { headers: { cookie: session.cookie } },
      ),
    )
    expect(res.status).toBe(403)
  })

  it("clamps a destination outside every allowed root back to the source's scope root", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "a"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const res = await app.request(
      new Request(
        "http://localhost/api/move/picker?source=public%2Fsrc.txt&dest=elsewhere",
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('value="public"')
    expect(text).toContain("a/")
  })

  it("exposes public and the caller's own home as picker roots", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "alice", password: "password1" },
      { username: "bob", password: "password2" },
    ])
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const session = await createTestSession("alice", SESSION_SECRET)
    const res = await app.request(
      new Request("http://localhost/api/move/picker?source=public%2Fsrc.txt", {
        headers: { cookie: session.cookie },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('data-picker-root="public"')
    expect(text).toContain('data-picker-root="private/alice"')
    expect(text).not.toContain("private/bob")
  })

  it("clamps another user's home back to the source's scope root", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "alice", password: "password1" },
      { username: "bob", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "bob"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "public", "src.txt"), "hello")

    const session = await createTestSession("alice", SESSION_SECRET)
    const res = await app.request(
      new Request(
        "http://localhost/api/move/picker?source=public%2Fsrc.txt&dest=private%2Fbob",
        { headers: { cookie: session.cookie } },
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('value="public"')
    expect(text).not.toContain('value="private/bob"')
  })

  it("limits an admin to the private tree for another user's entry", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "src.txt"),
      "secret",
    )

    const session = await createTestSession("admin", SESSION_SECRET)
    const res = await app.request(
      new Request(
        "http://localhost/api/move/picker?source=private%2Falice%2Fsrc.txt",
        { headers: { cookie: session.cookie } },
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain("data-picker-roots")
    expect(text).toContain('value="private/alice"')
    expect(text).not.toContain('data-picker-root="public"')
  })

  it("disables moving a directory into its own subtree", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "foo", "bar"), {
      recursive: true,
    })

    const res = await app.request(
      new Request(
        "http://localhost/api/move/picker?source=public%2Ffoo&dest=public%2Ffoo%2Fbar",
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("data-picker-invalid-destination")
    expect(text).toContain("disabled")
  })
})
