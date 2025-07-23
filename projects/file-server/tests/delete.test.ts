import { beforeEach, describe, expect, it } from "bun:test"
import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import app from "../src/index"

describe("delete", () => {
  const UPLOAD_DIR = "./tmp-test"

  beforeEach(async () => {
    await mkdir(UPLOAD_DIR, { recursive: true })
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })

  it("should delete a file", async () => {
    // 事前にファイルを作成
    const filePath = "delete-me.txt"
    const content = "bye"
    await Bun.write(path.join(UPLOAD_DIR, filePath), content)

    // 削除リクエスト
    const req = new Request("http://localhost/delete", {
      method: "DELETE",
      body: JSON.stringify({ path: filePath }),
      headers: { "Content-Type": "application/json" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData).toEqual({})
    // ファイルが消えていること
    await expect(
      Bun.file(path.join(UPLOAD_DIR, filePath)).text(),
    ).rejects.toThrow()
  })

  it("should delete a nested file", async () => {
    const filePath = "foo/bar/baz.txt"
    await mkdir(path.join(UPLOAD_DIR, "foo/bar"), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, filePath), "nested")
    const req = new Request("http://localhost/delete", {
      method: "DELETE",
      body: JSON.stringify({ path: filePath }),
      headers: { "Content-Type": "application/json" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData).toEqual({})
    await expect(
      Bun.file(path.join(UPLOAD_DIR, filePath)).text(),
    ).rejects.toThrow()
  })

  it("should return error for invalid path", async () => {
    const req = new Request("http://localhost/delete", {
      method: "DELETE",
      body: JSON.stringify({ path: "../../evil.txt" }),
      headers: { "Content-Type": "application/json" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const responseData = await res.json()
    expect(responseData.success).toBe(false)
    expect(responseData.error).toBeDefined()
    expect(responseData.error.name).toBe("PathError")
  })

  it("should return error for non-existent file", async () => {
    const req = new Request("http://localhost/delete", {
      method: "DELETE",
      body: JSON.stringify({ path: "notfound.txt" }),
      headers: { "Content-Type": "application/json" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const responseData = await res.json()
    expect(responseData.success).toBe(false)
    expect(responseData.error).toBeDefined()
    expect(responseData.error.name).toBe("FileNotFound")
  })
})
