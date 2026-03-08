import { beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import app from "../src/index"

const UPLOAD_DIR = "./tmp-test"

beforeEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
  await mkdir(UPLOAD_DIR, { recursive: true })
  process.env.UPLOAD_DIR = UPLOAD_DIR
  delete process.env.USERS_FILE
  delete process.env.SESSION_SECRET
})

describe("POST /api/file", () => {
  it("should create an empty file", async () => {
    const body = new URLSearchParams({ path: "", file: "new.txt" })
    const req = new Request("http://localhost/api/file", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=")

    const st = await stat(join(UPLOAD_DIR, "new.txt"))
    expect(st.isFile()).toBe(true)
    expect(st.size).toBe(0)
  })

  it("should create an empty file in subdirectory", async () => {
    await mkdir(join(UPLOAD_DIR, "parent"))
    const body = new URLSearchParams({ path: "parent/", file: "child.txt" })
    const req = new Request("http://localhost/api/file", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=parent%2F")

    const st = await stat(join(UPLOAD_DIR, "parent", "child.txt"))
    expect(st.isFile()).toBe(true)
    expect(st.size).toBe(0)
  })

  it("should return error when trying to create existing file", async () => {
    await Bun.write(join(UPLOAD_DIR, "exist.txt"), "")
    const body = new URLSearchParams({ path: "", file: "exist.txt" })
    const req = new Request("http://localhost/api/file", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("AlreadyExists")
    expect(json.error.message).toBe('"exist.txt" already exists.')
  })

  it("should return error when directory with same name exists", async () => {
    await mkdir(join(UPLOAD_DIR, "exist-dir"))
    const body = new URLSearchParams({ path: "", file: "exist-dir" })
    const req = new Request("http://localhost/api/file", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("AlreadyExists")
    expect(json.error.message).toBe('"exist-dir" already exists.')
  })

  it("should return error for invalid path", async () => {
    const body = new URLSearchParams({ path: "../bad", file: "test.txt" })
    const req = new Request("http://localhost/api/file", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("PathError")
  })

  it("should return error for invalid file name", async () => {
    const invalidNames = ["", ".", "..", "a/b", "a\\b"]

    for (const file of invalidNames) {
      const body = new URLSearchParams({ path: "", file })
      const req = new Request("http://localhost/api/file", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      })
      const res = await app.request(req)
      expect(res.status).toBe(400)
      const json = (await res.json()) as {
        success: boolean
        error: { name: string; message: string }
      }
      expect(json.success).toBe(false)
      expect(json.error.name).toBe("PathError")
    }
  })

  it("should create file via htmx and return HTML with updated file list", async () => {
    const body = new URLSearchParams({ path: "", file: "htmx-new.txt" })
    const req = new Request("http://localhost/api/file", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
    })
    const res = await app.request(req)

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("htmx-new.txt")
    expect(text).not.toContain("<html")
    expect(text).not.toContain("<head>")

    const st = await stat(join(UPLOAD_DIR, "htmx-new.txt"))
    expect(st.isFile()).toBe(true)
    expect(st.size).toBe(0)
  })

  it("should create file in subdirectory via htmx", async () => {
    await mkdir(join(UPLOAD_DIR, "htmx-parent"))
    const body = new URLSearchParams({
      path: "htmx-parent/",
      file: "htmx-child.txt",
    })
    const req = new Request("http://localhost/api/file", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
    })
    const res = await app.request(req)

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("htmx-child.txt")
    expect(text).toContain("htmx-parent")
    expect(text).not.toContain("<html")
    expect(text).toContain("data-form-error")

    const st = await stat(join(UPLOAD_DIR, "htmx-parent", "htmx-child.txt"))
    expect(st.isFile()).toBe(true)
    expect(st.size).toBe(0)
  })
})
