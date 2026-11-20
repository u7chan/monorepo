import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createTestSession } from "./helpers/auth"
import { createTestApp } from "./helpers/createTestApp"
import { type PlainUser, writeUsersFile } from "./helpers/userStore"

const UPLOAD_DIR = "./tmp-test-move-picker"
const AUTH_DIR = path.join(UPLOAD_DIR, ".auth")
const SESSION_SECRET = "0123456789abcdef0123456789abcdef"
let app: Awaited<ReturnType<typeof createTestApp>>

const writeUsers = (users: PlainUser[]) => writeUsersFile(AUTH_DIR, users)

beforeEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
  app = await createTestApp({ uploadDir: UPLOAD_DIR })
})

afterEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
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
