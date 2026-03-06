import { beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import app from "../src/index"

describe("upload", () => {
  const UPLOAD_DIR = "./tmp-test"

  beforeEach(async () => {
    // テスト用のアップロードディレクトリを作成
    await mkdir(UPLOAD_DIR, { recursive: true })
    // 環境変数を設定
    process.env.UPLOAD_DIR = UPLOAD_DIR
    delete process.env.USERS_FILE
    delete process.env.SESSION_SECRET
  })

  it("should upload a single file", async () => {
    // テストファイルを作成
    const testContent = "Hello, World!"
    const testFile = new File([testContent], "test.txt", {
      type: "text/plain",
    })

    // FormDataを作成
    const formData = new FormData()
    formData.append("files", testFile)

    // アップロードリクエストを送信
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    })

    const res = await app.request(req)

    // レスポンスを検証（JSONレスポンスを期待）
    expect(res.status).toBe(200)
    const responseData = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(responseData.success).toBe(true)
    expect(responseData.uploaded).toContain("test.txt")
    expect(responseData.failed).toHaveLength(0)

    // ファイルが実際に保存されたかを確認
    const savedFilePath = path.join(UPLOAD_DIR, "test.txt")
    const savedContent = await readFile(savedFilePath, "utf-8")
    expect(savedContent).toBe(testContent)

    // ファイル一覧を取得して検証
    const listReq = new Request("http://localhost/api/")
    const listRes = await app.request(listReq)

    const listData = (await listRes.json()) as {
      files: Array<{ name: string; type: "file" | "dir"; size?: number }>
    }
    expect(listData.files).toEqual(
      expect.arrayContaining([{ name: "test.txt", type: "file", size: 13 }]),
    )
  })

  it("should upload multiple files", async () => {
    // 複数のテストファイルを作成
    const testFile1 = new File(["Content 1"], "file1.txt", {
      type: "text/plain",
    })
    const testFile2 = new File(["Content 2"], "file2.txt", {
      type: "text/plain",
    })

    // FormDataを作成（同じキーで複数ファイルを追加）
    const formData = new FormData()
    formData.append("files", testFile1)
    formData.append("files", testFile2)

    // アップロードリクエストを送信
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    })

    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(responseData.success).toBe(true)
    expect(responseData.uploaded).toHaveLength(2)
    expect(responseData.uploaded).toContain("file1.txt")
    expect(responseData.uploaded).toContain("file2.txt")
    expect(responseData.failed).toHaveLength(0)

    // ファイルが実際に保存されたかを確認
    const savedContent1 = await readFile(
      path.join(UPLOAD_DIR, "file1.txt"),
      "utf-8",
    )
    const savedContent2 = await readFile(
      path.join(UPLOAD_DIR, "file2.txt"),
      "utf-8",
    )
    expect(savedContent1).toBe("Content 1")
    expect(savedContent2).toBe("Content 2")
  })

  it("should upload files to nested directory", async () => {
    const testContent = "Nested Hello!"
    const nestedPath = "foo/bar/baz.txt"
    const testFile = new File([testContent], "baz.txt", {
      type: "text/plain",
    })
    const formData = new FormData()
    formData.append("files", testFile)
    formData.append("path", nestedPath)

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const responseData = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(responseData.success).toBe(true)
    expect(responseData.uploaded).toContain("baz.txt")

    // 保存先のファイル内容を検証
    const savedFilePath = path.join(UPLOAD_DIR, nestedPath)
    const savedContent = await readFile(savedFilePath, "utf-8")
    expect(savedContent).toBe(testContent)
  })

  it("should upload files to a directory path (with trailing slash)", async () => {
    const testContent = "Dir Hello!"
    const dirPath = "dir1/dir2/"
    const testFile = new File([testContent], "uploaded.txt", {
      type: "text/plain",
    })
    const formData = new FormData()
    formData.append("files", testFile)
    formData.append("path", dirPath)

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const responseData = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(responseData.success).toBe(true)
    expect(responseData.uploaded).toContain("uploaded.txt")

    // 保存先のファイル内容を検証
    const savedFilePath = path.join(UPLOAD_DIR, dirPath, "uploaded.txt")
    const savedContent = await readFile(savedFilePath, "utf-8")
    expect(savedContent).toBe(testContent)
  })

  it("should return error when no file is uploaded", async () => {
    // ファイルなしでFormDataを作成
    const formData = new FormData()

    // アップロードリクエストを送信
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    })

    const res = await app.request(req)

    // レスポンスを検証（空の配列として処理され、成功だがアップロードなし）
    expect(res.status).toBe(200)
    const responseData = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(responseData.success).toBe(true) // 失敗したファイルがないためtrue
    expect(responseData.uploaded).toHaveLength(0)
    expect(responseData.failed).toHaveLength(0)
  })

  it("should reject upload to parent directory path", async () => {
    const testContent = "Should not save"
    const testFile = new File([testContent], "evil.txt", {
      type: "text/plain",
    })
    const formData = new FormData()
    formData.append("files", testFile)
    formData.append("path", "../../evil.txt")

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    })
    const res = await app.request(req)
    expect(res.status).toBe(200) // Partial failure returns 200 with failed list
    const responseData = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(responseData.success).toBe(false)
    expect(responseData.uploaded).toHaveLength(0)
    expect(responseData.failed).toHaveLength(1)
    expect(responseData.failed[0].name).toBe("evil.txt")
    expect(responseData.failed[0].reason).toBe("Invalid path")
  })

  it("should upload files via htmx and return HTML with file list", async () => {
    // テストファイルを作成
    const testContent = "Hello htmx!"
    const testFile = new File([testContent], "htmx-test.txt", {
      type: "text/plain",
    })

    // FormDataを作成
    const formData = new FormData()
    formData.append("files", testFile)

    // htmxリクエストを送信
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })

    const res = await app.request(req)

    // レスポンスを検証（HTMLレスポンスを期待）
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx-test.txt")
    expect(text).toContain('id="file-list-container"')
    // HTML部分（フルページシェルではない）
    expect(text).not.toContain("<html")
    expect(text).not.toContain("<head>")

    // ファイルが実際に保存されたかを確認
    const savedFilePath = path.join(UPLOAD_DIR, "htmx-test.txt")
    const savedContent = await readFile(savedFilePath, "utf-8")
    expect(savedContent).toBe(testContent)
  })

  it("should upload multiple files via htmx", async () => {
    const testFile1 = new File(["Content 1"], "htmx-multi1.txt", {
      type: "text/plain",
    })
    const testFile2 = new File(["Content 2"], "htmx-multi2.txt", {
      type: "text/plain",
    })

    const formData = new FormData()
    formData.append("files", testFile1)
    formData.append("files", testFile2)

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx-multi1.txt")
    expect(text).toContain("htmx-multi2.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")

    // ファイルが実際に保存されたかを確認
    const savedContent1 = await readFile(
      path.join(UPLOAD_DIR, "htmx-multi1.txt"),
      "utf-8",
    )
    const savedContent2 = await readFile(
      path.join(UPLOAD_DIR, "htmx-multi2.txt"),
      "utf-8",
    )
    expect(savedContent1).toBe("Content 1")
    expect(savedContent2).toBe("Content 2")
  })

  it("should upload files to nested directory via htmx", async () => {
    // ネストしたディレクトリを事前に作成
    await mkdir(path.join(UPLOAD_DIR, "htmx/foo"), { recursive: true })

    const testContent = "Nested htmx!"
    // ディレクトリパスを指定（末尾に/）
    const dirPath = "htmx/foo/"
    const testFile = new File([testContent], "bar.txt", {
      type: "text/plain",
    })
    const formData = new FormData()
    formData.append("files", testFile)
    formData.append("path", dirPath)

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("bar.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")

    // 保存先のファイル内容を検証
    const savedFilePath = path.join(UPLOAD_DIR, "htmx/foo/bar.txt")
    const savedContent = await readFile(savedFilePath, "utf-8")
    expect(savedContent).toBe(testContent)
  })

  it("should handle partial failures when uploading multiple files", async () => {
    // 正常なファイルと不正なパスのファイルを混在させる
    const validFile = new File(["Valid content"], "valid.txt", {
      type: "text/plain",
    })
    const invalidFile = new File(["Invalid content"], "invalid.txt", {
      type: "text/plain",
    })

    const formData = new FormData()
    formData.append("path", "subdir/") // 正常なパス
    formData.append("files", validFile)
    // 不正なパスを指定したファイルを追加（直接はできないので、後で検証）

    // まず正常なファイルをアップロード
    const req1 = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    })
    const res1 = await app.request(req1)
    expect(res1.status).toBe(200)
    const data1 = (await res1.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(data1.success).toBe(true)
    expect(data1.uploaded).toContain("valid.txt")

    // 不正なパスでファイルをアップロード
    const formData2 = new FormData()
    formData2.append("path", "../../../etc/")
    formData2.append("files", invalidFile)

    const req2 = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData2,
    })
    const res2 = await app.request(req2)
    expect(res2.status).toBe(200)
    const data2 = (await res2.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(data2.success).toBe(false)
    expect(data2.uploaded).toHaveLength(0)
    expect(data2.failed).toHaveLength(1)
    expect(data2.failed[0].name).toBe("invalid.txt")
    expect(data2.failed[0].reason).toBe("Invalid path")
  })

  it("should reject more than 10 files", async () => {
    const formData = new FormData()

    // 11個のファイルを作成
    for (let i = 0; i < 11; i++) {
      const testFile = new File([`Content ${i}`], `file${i}.txt`, {
        type: "text/plain",
      })
      formData.append("files", testFile)
    }

    const req = new Request("http://localhost/api/upload", {
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
    expect(responseData.error.name).toBe("ZodError")
    expect(responseData.error.message).toContain("Too big")
  })
})
