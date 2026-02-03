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
    const formData = new FormData()
    formData.append("path", filePath)
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    // ファイル削除後は親ディレクトリにリダイレクト
    expect(res.headers.get("location")).toBe("/?path=")
    // ファイルが消えていること
    expect(Bun.file(path.join(UPLOAD_DIR, filePath)).text()).rejects.toThrow()
  })

  it("should delete a nested file", async () => {
    const filePath = "foo/bar/baz.txt"
    await mkdir(path.join(UPLOAD_DIR, "foo/bar"), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, filePath), "nested")
    const formData = new FormData()
    formData.append("path", filePath)
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    // ネストしたファイル削除後は親ディレクトリにリダイレクト
    expect(res.headers.get("location")).toBe("/?path=foo/bar")
    expect(Bun.file(path.join(UPLOAD_DIR, filePath)).text()).rejects.toThrow()
  })

  it("should delete a directory (empty)", async () => {
    const dirPath = "empty-dir"
    await mkdir(path.join(UPLOAD_DIR, dirPath), { recursive: true })
    const formData = new FormData()
    formData.append("path", dirPath)
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    // ディレクトリ削除後は親ディレクトリにリダイレクト
    expect(res.headers.get("location")).toBe("/?path=")
    // ディレクトリが消えていること
    expect(Bun.file(path.join(UPLOAD_DIR, dirPath)).text()).rejects.toThrow()
  })

  it("should delete a directory (with files)", async () => {
    const dirPath = "dir-with-files"
    const filePath = path.join(dirPath, "file.txt")
    await mkdir(path.join(UPLOAD_DIR, dirPath), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, filePath), "data")
    const formData = new FormData()
    formData.append("path", dirPath)
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(301)
    // ディレクトリ削除後は親ディレクトリにリダイレクト
    expect(res.headers.get("location")).toBe("/?path=")
    // ディレクトリが消えていること
    expect(Bun.file(path.join(UPLOAD_DIR, dirPath)).text()).rejects.toThrow()
  })

  it("should return error for invalid path", async () => {
    const formData = new FormData()
    formData.append("path", "../../evil.txt")
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const responseData = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(responseData.success).toBe(false)
    expect(responseData.error).toBeDefined()
    expect(responseData.error.name).toBe("PathError")
  })

  it("should return error for non-existent file", async () => {
    const formData = new FormData()
    formData.append("path", "notfound.txt")
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const responseData = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(responseData.success).toBe(false)
    expect(responseData.error).toBeDefined()
    expect(responseData.error.name).toBe("FileNotFound")
  })

  it("should delete a file via htmx and return HTML with updated file list", async () => {
    // 事前にファイルを作成
    const filePath = "delete-htmx.txt"
    const content = "delete me via htmx"
    await Bun.write(path.join(UPLOAD_DIR, filePath), content)
    // 追加のファイルも作成してリストを確認
    await Bun.write(path.join(UPLOAD_DIR, "other.txt"), "other")

    // 削除リクエスト（htmx）
    const formData = new FormData()
    formData.append("path", filePath)
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)

    // HTMLレスポンスを期待
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("other.txt") // 残っているファイル
    expect(text).not.toContain("delete-htmx.txt") // 削除されたファイル
    expect(text).not.toContain("<html") // 部分HTML
    expect(text).not.toContain("<head>")

    // ファイルが消えていること
    expect(Bun.file(path.join(UPLOAD_DIR, filePath)).text()).rejects.toThrow()
  })

  it("should delete a directory via htmx and return HTML with updated file list", async () => {
    const dirPath = "dir-to-delete-htmx"
    await mkdir(path.join(UPLOAD_DIR, dirPath), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, dirPath, "file.txt"), "content")

    const formData = new FormData()
    formData.append("path", dirPath)
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("dir-to-delete-htmx") // 削除されたディレクトリ
    expect(text).not.toContain("<html") // 部分HTML

    // ディレクトリが消えていること
    expect(Bun.file(path.join(UPLOAD_DIR, dirPath)).text()).rejects.toThrow()
  })

  it("should delete a nested file via htmx and return HTML with correct parent directory", async () => {
    const filePath = "foo/htmx-delete.txt"
    await mkdir(path.join(UPLOAD_DIR, "foo"), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, filePath), "nested delete")
    // 親ディレクトリに別のファイルも作成
    await Bun.write(path.join(UPLOAD_DIR, "foo", "sibling.txt"), "sibling")

    const formData = new FormData()
    formData.append("path", filePath)
    const req = new Request("http://localhost/api/delete", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("sibling.txt") // 残っているファイル
    expect(text).not.toContain("htmx-delete.txt") // 削除されたファイル
    // パンくずリストにfooが含まれることを確認
    expect(text).toContain("foo")
  })
})
