import { beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import app from "../src/index"

describe("update", () => {
  const UPLOAD_DIR = "./tmp-test"

  beforeEach(async () => {
    // テスト用のアップロードディレクトリを作成
    await mkdir(UPLOAD_DIR, { recursive: true })
    // 環境変数を設定
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })

  it("should update a text file via API", async () => {
    // テストファイルを事前に作成
    const testFilePath = path.join(UPLOAD_DIR, "test-update.txt")
    await writeFile(testFilePath, "Initial content", "utf-8")

    // 更新内容
    const newContent = "Updated content!"

    // FormDataを作成
    const formData = new FormData()
    formData.append("path", "test-update.txt")
    formData.append("content", newContent)

    // 更新リクエストを送信
    const req = new Request("http://localhost/api/update", {
      method: "POST",
      body: formData,
    })

    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = (await res.json()) as { success: boolean }
    expect(responseData.success).toBe(true)

    // ファイルが実際に更新されたかを確認
    const savedContent = await readFile(testFilePath, "utf-8")
    expect(savedContent).toBe(newContent)
  })

  it("should update a text file via htmx and return HTML", async () => {
    // テストファイルを事前に作成
    const testFilePath = path.join(UPLOAD_DIR, "htmx-update.txt")
    await writeFile(testFilePath, "Initial htmx content", "utf-8")

    // 更新内容
    const newContent = "Updated via htmx!"

    // FormDataを作成
    const formData = new FormData()
    formData.append("path", "htmx-update.txt")
    formData.append("content", newContent)

    // htmxリクエストを送信
    const req = new Request("http://localhost/api/update", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })

    const res = await app.request(req)

    // レスポンスを検証（HTMLレスポンスを期待）
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx-update.txt")
    expect(text).toContain(newContent)
    expect(text).toContain('id="file-viewer-container"')
    // HTML部分（フルページシェルではない）
    expect(text).not.toContain("<html")
    expect(text).not.toContain("<head>")

    // ファイルが実際に更新されたかを確認
    const savedContent = await readFile(testFilePath, "utf-8")
    expect(savedContent).toBe(newContent)
  })

  it("should return error when file does not exist", async () => {
    // FormDataを作成（存在しないファイル）
    const formData = new FormData()
    formData.append("path", "non-existent.txt")
    formData.append("content", "New content")

    // 更新リクエストを送信
    const req = new Request("http://localhost/api/update", {
      method: "POST",
      body: formData,
    })

    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(400)
    const responseData = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(responseData.success).toBe(false)
    expect(responseData.error.name).toBe("FileNotFound")
  })

  it("should reject update to parent directory path", async () => {
    // テストファイルを事前に作成
    const testFilePath = path.join(UPLOAD_DIR, "evil.txt")
    await writeFile(testFilePath, "Initial content", "utf-8")

    // FormDataを作成（親ディレクトリへのパス）
    const formData = new FormData()
    formData.append("path", "../../evil.txt")
    formData.append("content", "Hacked!")

    // 更新リクエストを送信
    const req = new Request("http://localhost/api/update", {
      method: "POST",
      body: formData,
    })

    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(400)
    const responseData = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(responseData.success).toBe(false)
    expect(responseData.error.name).toBe("PathError")

    // ファイルが変更されていないことを確認
    const savedContent = await readFile(testFilePath, "utf-8")
    expect(savedContent).toBe("Initial content")
  })

  it("should return error when path is a directory", async () => {
    // テスト用ディレクトリを作成
    const testDirPath = path.join(UPLOAD_DIR, "testdir")
    await mkdir(testDirPath, { recursive: true })

    // FormDataを作成（ディレクトリパス）
    const formData = new FormData()
    formData.append("path", "testdir")
    formData.append("content", "New content")

    // 更新リクエストを送信
    const req = new Request("http://localhost/api/update", {
      method: "POST",
      body: formData,
    })

    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(400)
    const responseData = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(responseData.success).toBe(false)
    expect(responseData.error.name).toBe("NotAFile")
  })

  it("should update a file in nested directory", async () => {
    // ネストしたディレクトリとファイルを作成
    const nestedDir = path.join(UPLOAD_DIR, "update/foo")
    await mkdir(nestedDir, { recursive: true })
    const testFilePath = path.join(nestedDir, "bar.txt")
    await writeFile(testFilePath, "Nested initial content", "utf-8")

    // 更新内容
    const newContent = "Updated nested content!"

    // FormDataを作成
    const formData = new FormData()
    formData.append("path", "update/foo/bar.txt")
    formData.append("content", newContent)

    // htmxリクエストを送信
    const req = new Request("http://localhost/api/update", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })

    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("bar.txt")
    expect(text).toContain(newContent)

    // ファイルが実際に更新されたかを確認
    const savedContent = await readFile(testFilePath, "utf-8")
    expect(savedContent).toBe(newContent)
  })
})
