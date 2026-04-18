import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { createTestApp } from "./helpers/createTestApp"

const UPLOAD_DIR = "./tmp-test-mkdir"
let app: Awaited<ReturnType<typeof createTestApp>>

beforeEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
  app = await createTestApp({ uploadDir: UPLOAD_DIR })
})

afterEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
})

describe("POST /api/mkdir", () => {
  it("should create a directory in the public scope", async () => {
    const body = new URLSearchParams({ path: "public", folder: "newdir" })
    const res = await app.request(
      new Request("http://localhost/api/mkdir", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=public")
    const st = await stat(join(UPLOAD_DIR, "public", "newdir"))
    expect(st.isDirectory()).toBe(true)
  })

  it("should return error when trying to create existing directory", async () => {
    await mkdir(join(UPLOAD_DIR, "public", "existdir"))
    const body = new URLSearchParams({ path: "public", folder: "existdir" })
    const res = await app.request(
      new Request("http://localhost/api/mkdir", {
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
    expect(json.error.message).toBe('"existdir" already exists.')
  })

  it("should return error for invalid path", async () => {
    const body = new URLSearchParams({ path: "../bad", folder: "test" })
    const res = await app.request(
      new Request("http://localhost/api/mkdir", {
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

  it("should create directory in subdirectory", async () => {
    await mkdir(join(UPLOAD_DIR, "public", "parent"))
    const body = new URLSearchParams({ path: "public/parent", folder: "child" })
    const res = await app.request(
      new Request("http://localhost/api/mkdir", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    )
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=public%2Fparent")
    const st = await stat(join(UPLOAD_DIR, "public", "parent", "child"))
    expect(st.isDirectory()).toBe(true)
  })

  it("should create directory via htmx and return HTML with updated file list", async () => {
    const body = new URLSearchParams({ path: "public", folder: "htmx-newdir" })
    const res = await app.request(
      new Request("http://localhost/api/mkdir", {
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
    expect(text).toContain("htmx-newdir/")
    expect(text).not.toContain("<html")

    const st = await stat(join(UPLOAD_DIR, "public", "htmx-newdir"))
    expect(st.isDirectory()).toBe(true)
  })

  it("should create directory in subdirectory via htmx", async () => {
    await mkdir(join(UPLOAD_DIR, "public", "htmx-parent"))
    const body = new URLSearchParams({
      path: "public/htmx-parent",
      folder: "htmx-child",
    })
    const res = await app.request(
      new Request("http://localhost/api/mkdir", {
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
    expect(text).toContain("htmx-child/")
    expect(text).toContain("htmx-parent")
    expect(text).not.toContain("<html")

    const st = await stat(
      join(UPLOAD_DIR, "public", "htmx-parent", "htmx-child"),
    )
    expect(st.isDirectory()).toBe(true)
  })
})
