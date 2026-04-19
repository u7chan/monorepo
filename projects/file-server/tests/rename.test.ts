import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { getUsersFilePath } from "../src/utils/auth"
import { resetUsersCacheForTests } from "../src/utils/userConfigCache"
import { createTestSession } from "./helpers/auth"
import { createTestApp } from "./helpers/createTestApp"

const UPLOAD_DIR = "./tmp-test-rename"
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

beforeEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
  app = await createTestApp({ uploadDir: UPLOAD_DIR })
})

afterEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
})

describe("POST /api/rename", () => {
  it("renames a file in the public root directory", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "before.txt"), "content")

    const body = new URLSearchParams({
      path: "public/before.txt",
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
    expect(res.headers.get("location")).toBe("/?path=public")
    expect(
      await readFile(path.join(UPLOAD_DIR, "public", "after.txt"), "utf-8"),
    ).toBe("content")
    expect(
      Bun.file(path.join(UPLOAD_DIR, "public", "before.txt")).text(),
    ).rejects.toThrow()
  })

  it("renames a file in a subdirectory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "parent"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "public", "parent", "before.txt"),
      "nested",
    )

    const body = new URLSearchParams({
      path: "public/parent/before.txt",
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
    expect(res.headers.get("location")).toBe("/?path=public%2Fparent")
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "public", "parent", "after.txt"),
        "utf-8",
      ),
    ).toBe("nested")
  })

  it("renames a directory and keeps its contents", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "before-dir"), {
      recursive: true,
    })
    await writeFile(
      path.join(UPLOAD_DIR, "public", "before-dir", "inside.txt"),
      "inside-content",
    )

    const body = new URLSearchParams({
      path: "public/before-dir",
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
    expect(res.headers.get("location")).toBe("/?path=public")
    expect(
      await stat(path.join(UPLOAD_DIR, "public", "after-dir")),
    ).toMatchObject({
      isDirectory: expect.any(Function),
    })
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "public", "after-dir", "inside.txt"),
        "utf-8",
      ),
    ).toBe("inside-content")
  })

  it("treats same-name rename as a success no-op", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "same.txt"), "same-content")

    const body = new URLSearchParams({
      path: "public/same.txt",
      name: "same.txt",
    })
    const res = await app.request(
      new Request("http://localhost/api/rename", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=public")
    expect(
      await readFile(path.join(UPLOAD_DIR, "public", "same.txt"), "utf-8"),
    ).toBe("same-content")
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
      error: { name: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("PathError")
  })

  it("rejects invalid target names", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "before.txt"), "content")

    for (const name of ["", ".", "..", "a/b", "a\\b"]) {
      const body = new URLSearchParams({ path: "public/before.txt", name })
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
        error: { name: string }
      }
      expect(json.success).toBe(false)
      expect(json.error.name).toBe("PathError")
    }
  })

  it("returns FileNotFound when the source does not exist", async () => {
    const body = new URLSearchParams({
      path: "public/missing.txt",
      name: "after.txt",
    })
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
      error: { name: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("FileNotFound")
  })

  it("returns AlreadyExists when the destination already exists", async () => {
    await writeFile(path.join(UPLOAD_DIR, "public", "before.txt"), "content")
    await writeFile(path.join(UPLOAD_DIR, "public", "after.txt"), "existing")

    const body = new URLSearchParams({
      path: "public/before.txt",
      name: "after.txt",
    })
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
    await writeFile(path.join(UPLOAD_DIR, "public", "before.txt"), "content")

    const body = new URLSearchParams({
      path: "public/before.txt",
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
    expect(text).toContain("after.txt")
    expect(text).not.toContain("before.txt")
    expect(text).toContain('hx-post="/api/rename"')
    expect(text).not.toContain("<html")
  })

  it("keeps the parent breadcrumb in nested htmx renames", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "foo"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "public", "foo", "before.txt"),
      "content",
    )

    const body = new URLSearchParams({
      path: "public/foo/before.txt",
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
    await writeFile(
      path.join(UPLOAD_DIR, "public", "browse-test.txt"),
      "content",
    )

    const res = await app.request(new Request("http://localhost/?path=public"))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('hx-post="/api/rename"')
    expect(text).toContain('aria-label="Rename"')
    expect(text).toContain('value="browse-test.txt"')
  })

  it("prevents authenticated users from renaming outside their scope (path traversal)", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([{ username: "alice", password: "password1" }])

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
      error: { name: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("PathError")
  })

  it("allows admins to rename items in private area", async () => {
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      authDir: AUTH_DIR,
      sessionSecret: SESSION_SECRET,
    })
    await writeUsers([
      { username: "admin", password: "password1", role: "admin" },
      { username: "alice", password: "password2", role: "user" },
    ])
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await writeFile(
      path.join(UPLOAD_DIR, "private", "alice", "before.txt"),
      "content",
    )

    const session = await createTestSession("admin", SESSION_SECRET)
    const body = new URLSearchParams({
      path: "private/alice/before.txt",
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
    expect(res.headers.get("location")).toBe("/?path=private%2Falice")
    expect(
      await readFile(
        path.join(UPLOAD_DIR, "private", "alice", "after.txt"),
        "utf-8",
      ),
    ).toBe("content")
  })
})
