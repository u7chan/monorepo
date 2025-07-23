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
  it("空のディレクトリを作成できる", async () => {
    const body = new URLSearchParams({ path: "newdir" })
    const req = new Request("http://localhost/api/mkdir", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({})
    // 実際にディレクトリができているか
    const st = await stat(join(UPLOAD_DIR, "newdir"))
    expect(st.isDirectory()).toBe(true)
  })

  it("既存ディレクトリを作成しようとするとエラー", async () => {
    await mkdir(join(UPLOAD_DIR, "existdir"))
    const body = new URLSearchParams({ path: "existdir" })
    const req = new Request("http://localhost/api/mkdir", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("AlreadyExists")
  })

  it("不正なパスはエラー", async () => {
    const body = new URLSearchParams({ path: "../bad" })
    const req = new Request("http://localhost/api/mkdir", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error.name).toBe("PathError")
  })
})
