import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import app from "../src/index"
import { resetUsersCacheForTests } from "../src/utils/userConfigCache"
import { createTestSession } from "./helpers/auth"

const UPLOAD_DIR = "./tmp-test-rename"
const USERS_FILE = path.join(UPLOAD_DIR, "users.json")
const SESSION_SECRET = "0123456789abcdef0123456789abcdef"

type PlainUser = {
  username: string
  password: string
  role?: "admin" | "user"
}

async function writeUsers(users: PlainUser[]) {
  const userConfigs = await Promise.all(
    users.map(async (user) => ({
      username: user.username,
      passwordHash: await Bun.password.hash(user.password, {
        algorithm: "bcrypt",
        cost: 4,
      }),
      role: user.role ?? "user",
    })),
  )
  await writeFile(USERS_FILE, JSON.stringify(userConfigs), "utf-8")
}

describe("POST /api/rename", () => {
  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    await mkdir(UPLOAD_DIR, { recursive: true })
    process.env.UPLOAD_DIR = UPLOAD_DIR
    delete process.env.USERS_FILE
    delete process.env.SESSION_SECRET
    resetUsersCacheForTests()
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    delete process.env.USERS_FILE
    delete process.env.SESSION_SECRET
    resetUsersCacheForTests()
  })

  it("renames a file in the root directory", async () => {
    await writeFile(path.join(UPLOAD_DIR, "before.txt"), "content")

    const body = new URLSearchParams({ path: "before.txt", name: "after.txt" })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )

    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=")
    expect(await readFile(path.join(UPLOAD_DIR, "after.txt"), "utf-8")).toBe(
      "content",
    )
    expect(
      Bun.file(path.join(UPLOAD_DIR, "before.txt")).text(),
    ).rejects.toThrow()
  })

  it("renames a file in a subdirectory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "parent"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "parent", "before.txt"), "nested")

    const body = new URLSearchParams({
      path: "parent/before.txt",
      name: "after.txt",
    })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )

    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=parent")
    expect(
      await readFile(path.join(UPLOAD_DIR, "parent", "after.txt"), "utf-8"),
    ).toBe("nested")
  })

  it("renames a directory and keeps its contents", async () => {
    await mkdir(path.join(UPLOAD_DIR, "before-dir"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "before-dir", "inside.txt"),
      "inside-content",
    )

    const body = new URLSearchParams({
      path: "before-dir",
      name: "after-dir",
    })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )

    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=")
    expect(await stat(path.join(UPLOAD_DIR, "after-dir"))).toMatchObject({
      isDirectory: expect.any(Function),
    })
    expect(
      await readFile(path.join(UPLOAD_DIR, "after-dir", "inside.txt"), "utf-8"),
    ).toBe("inside-content")
  })

  it("treats same-name rename as a success no-op", async () => {
    await writeFile(path.join(UPLOAD_DIR, "same.txt"), "same-content")

    const body = new URLSearchParams({ path: "same.txt", name: "same.txt" })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )

    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=")
    expect(await readFile(path.join(UPLOAD_DIR, "same.txt"), "utf-8")).toBe(
      "same-content",
    )
  })

  it("rejects invalid source paths", async () => {
    const body = new URLSearchParams({ path: "../bad", name: "after.txt" })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )

    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("PathError")
  })

  it("rejects invalid target names", async () => {
    await writeFile(path.join(UPLOAD_DIR, "before.txt"), "content")

    for (const name of ["", ".", "..", "a/b", "a\\b"]) {
      const body = new URLSearchParams({ path: "before.txt", name })
      const res = await app.request(
        new Request("http://localhost/api/rename", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
        }),
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as {
        success: boolean
        error: { name: string; message: string }
      }
      expect(json.success).toBe(false)
      expect(json.error.name).toBe("PathError")
    }
  })

  it("returns FileNotFound when the source does not exist", async () => {
    const body = new URLSearchParams({ path: "missing.txt", name: "after.txt" })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )

    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("FileNotFound")
  })

  it("returns AlreadyExists when the destination already exists", async () => {
    await writeFile(path.join(UPLOAD_DIR, "before.txt"), "content")
    await writeFile(path.join(UPLOAD_DIR, "after.txt"), "existing")

    const body = new URLSearchParams({ path: "before.txt", name: "after.txt" })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )

    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("AlreadyExists")
    expect(json.error.message).toBe('"after.txt" already exists.')
  })

  it("returns updated HTML via htmx", async () => {
    await writeFile(path.join(UPLOAD_DIR, "before.txt"), "content")

    const body = new URLSearchParams({ path: "before.txt", name: "after.txt" })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "HX-Request": "true",
        },
      }),
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("after.txt")
    expect(text).not.toContain("before.txt")
    expect(text).toContain('hx-post="/api/rename"')
    expect(text).toContain("data-form-error")
    expect(text).not.toContain("<html")
  })

  it("keeps the parent breadcrumb in nested htmx renames", async () => {
    await mkdir(path.join(UPLOAD_DIR, "foo"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "foo", "before.txt"), "content")

    const body = new URLSearchParams({
      path: "foo/before.txt",
      name: "after.txt",
    })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "HX-Request": "true",
        },
      }),
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("foo")
    expect(text).toContain("after.txt")
    expect(text).not.toContain("before.txt")
  })

  it("pre-renders rename controls in the browse view", async () => {
    await writeFile(path.join(UPLOAD_DIR, "browse-test.txt"), "content")

    const res = await app.request(new Request("http://localhost/?path="))

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('hx-post="/api/rename"')
    expect(text).toContain('aria-label="Rename"')
    expect(text).toContain("hidden sm:inline")
    expect(text).toContain("sm:hidden")
    expect(text).toContain("h-8 w-8")
    expect(text).toContain('value="browse-test.txt"')
    expect(text).toContain("data-form-error")
  })

  it("prevents authenticated users from renaming outside their scope", async () => {
    process.env.USERS_FILE = USERS_FILE
    process.env.SESSION_SECRET = SESSION_SECRET
    await writeUsers([{ username: "alice", password: "password1" }])
    await mkdir(path.join(UPLOAD_DIR, "alice"), { recursive: true })

    const session = await createTestSession("alice", SESSION_SECRET)
    const body = new URLSearchParams({ path: "../bob/file.txt", name: "x.txt" })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: session.cookie,
        },
      }),
    )

    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("PathError")
  })

  it("allows admins to rename items under the upload root", async () => {
    process.env.USERS_FILE = USERS_FILE
    process.env.SESSION_SECRET = SESSION_SECRET
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2", role: "user" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "alice"), { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, "alice", "before.txt"), "content")

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "alice/before.txt",
      name: "after.txt",
    })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: session.cookie,
        },
      }),
    )

    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=alice")
    expect(
      await readFile(path.join(UPLOAD_DIR, "alice", "after.txt"), "utf-8"),
    ).toBe("content")
  })
})
