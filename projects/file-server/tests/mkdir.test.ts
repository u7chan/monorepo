import { beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import app from "../src/index"

const UPLOAD_DIR = "./tmp-test"

beforeEach(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true })
  await mkdir(UPLOAD_DIR, { recursive: true })
  process.env.UPLOAD_DIR = UPLOAD_DIR
})

describe("POST /api/mkdir", () => {
  it("should create an empty directory", async () => {
    const body = new URLSearchParams({ path: "", folder: "newdir" })
    const req = new Request("http://localhost/api/mkdir", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=")
    // Check if directory was actually created
    const st = await stat(join(UPLOAD_DIR, "newdir"))
    expect(st.isDirectory()).toBe(true)
  })

  it("should return error when trying to create existing directory", async () => {
    await mkdir(join(UPLOAD_DIR, "existdir"))
    const body = new URLSearchParams({ path: "", folder: "existdir" })
    const req = new Request("http://localhost/api/mkdir", {
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
  })

  it("should return error for invalid path", async () => {
    const body = new URLSearchParams({ path: "../bad", folder: "test" })
    const req = new Request("http://localhost/api/mkdir", {
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

  it("should create directory in subdirectory", async () => {
    // Create parent directory
    await mkdir(join(UPLOAD_DIR, "parent"))
    const body = new URLSearchParams({ path: "parent/", folder: "child" })
    const req = new Request("http://localhost/api/mkdir", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/?path=parent%2F")
    // Check if directory was actually created
    const st = await stat(join(UPLOAD_DIR, "parent", "child"))
    expect(st.isDirectory()).toBe(true)
  })

  it("should create directory via htmx and return HTML with updated file list", async () => {
    const body = new URLSearchParams({ path: "", folder: "htmx-newdir" })
    const req = new Request("http://localhost/api/mkdir", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
    })
    const res = await app.request(req)

    // HTMLレスポンスを期待
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("htmx-newdir/") // 作成されたディレクトリ
    expect(text).not.toContain("<html") // 部分HTML
    expect(text).not.toContain("<head>")

    // ディレクトリが実際に作成されたか確認
    const st = await stat(join(UPLOAD_DIR, "htmx-newdir"))
    expect(st.isDirectory()).toBe(true)
  })

  it("should create directory in subdirectory via htmx", async () => {
    // Create parent directory
    await mkdir(join(UPLOAD_DIR, "htmx-parent"))
    const body = new URLSearchParams({
      path: "htmx-parent/",
      folder: "htmx-child",
    })
    const req = new Request("http://localhost/api/mkdir", {
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
    expect(text).toContain("htmx-child/") // 作成されたディレクトリ
    expect(text).toContain("htmx-parent") // パンくずリストに親ディレクトリが含まれる
    expect(text).not.toContain("<html")

    // Check if directory was actually created
    const st = await stat(join(UPLOAD_DIR, "htmx-parent", "htmx-child"))
    expect(st.isDirectory()).toBe(true)
  })
})
