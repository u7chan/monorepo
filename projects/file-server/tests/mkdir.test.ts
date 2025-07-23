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
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({})
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
    const json = await res.json()
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
    const json = await res.json()
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
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({})
    // Check if directory was actually created
    const st = await stat(join(UPLOAD_DIR, "parent", "child"))
    expect(st.isDirectory()).toBe(true)
  })
})
