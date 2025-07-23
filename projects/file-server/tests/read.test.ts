import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import * as path from "node:path"
import app from "../src/index"

describe("read", () => {
  const UPLOAD_DIR = "./tmp-test"

  beforeEach(async () => {
    // 既存のディレクトリを削除してから作成
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {
      // ディレクトリが存在しない場合は無視
    }
    // テスト用のアップロードディレクトリを作成
    await mkdir(UPLOAD_DIR, { recursive: true })
    // 環境変数を設定
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })

  afterEach(async () => {
    // テスト用ディレクトリをクリーンアップ
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {
      // ディレクトリが存在しない場合は無視
    }
  })

  it("should return empty files list when directory is empty", async () => {
    // ファイル一覧取得リクエスト
    const req = new Request("http://localhost/api/")
    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData.files).toEqual([])
  })

  it("should return files list when files exist", async () => {
    // テストファイルを作成
    await Bun.write(path.join(UPLOAD_DIR, "test1.txt"), "Hello, World!")
    await Bun.write(path.join(UPLOAD_DIR, "test2.txt"), "Test content")

    // ファイル一覧取得リクエスト
    const req = new Request("http://localhost/api/")
    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData.files).toEqual(
      expect.arrayContaining([
        { name: "test1.txt", type: "file", size: 13 },
        { name: "test2.txt", type: "file", size: 12 },
      ]),
    )
    expect(responseData.files).toHaveLength(2)
  })

  it("should return files list in subdirectory when subpath is specified", async () => {
    // サブディレクトリとファイルを作成
    await mkdir(path.join(UPLOAD_DIR, "foo/bar"), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, "foo/bar", "baz.txt"), "baz content")
    await Bun.write(path.join(UPLOAD_DIR, "foo/bar", "qux.txt"), "qux content")
    // サブディレクトリ直下のファイルも作成
    await Bun.write(path.join(UPLOAD_DIR, "foo", "root.txt"), "root content")

    // サブパス指定でリクエスト
    const req = new Request("http://localhost/api/foo/bar")
    const res = await app.request(req)

    // レスポンスを検証
    expect(res.status).toBe(200)
    const responseData = await res.json()
    expect(responseData.files).toEqual(
      expect.arrayContaining([
        { name: "baz.txt", type: "file", size: 11 },
        { name: "qux.txt", type: "file", size: 11 },
      ]),
    )
    expect(responseData.files).toHaveLength(2)
  })

  it("should handle non-existent directory gracefully", async () => {
    // 存在しないディレクトリを設定
    process.env.UPLOAD_DIR = "./non-existent-dir"

    // ファイル一覧取得リクエスト
    const req = new Request("http://localhost/api/")
    const res = await app.request(req)

    // レスポンスを検証（エラーが発生するはず）
    expect(res.status).toBe(400)
    const responseData = await res.json()
    expect(responseData.success).toBe(false)
    expect(responseData.error).toBeDefined()
    expect(responseData.error.name).toBe("DirNotFound")

    // 環境変数を元に戻す
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })
})

describe("browse endpoint /", () => {
  const UPLOAD_DIR = "./tmp-test"
  beforeEach(async () => {
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {}
    await mkdir(UPLOAD_DIR, { recursive: true })
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })
  afterEach(async () => {
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {}
  })

  it("should render directory listing as HTML", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "foo.txt"), "foo content")
    await Bun.write(path.join(UPLOAD_DIR, "bar.txt"), "bar content")
    const req = new Request("http://localhost/?path=", { method: "GET" })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("foo.txt")
    expect(text).toContain("bar.txt")
    expect(text).toContain("<a href")
  })

  it("should render breadcrumb navigation in directory listing as HTML", async () => {
    // ディレクトリ階層を作成
    await mkdir(path.join(UPLOAD_DIR, "foo/bar/baz"), { recursive: true })
    // パス付きでアクセス
    const req = new Request("http://localhost/?path=foo/bar/baz", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    // パンくずリストの各階層リンクが含まれること
    expect(text).toContain('<a href="/">root</a>')
    expect(text).toContain('<a href="/?path=foo">foo</a>')
    expect(text).toContain('<a href="/?path=foo%2Fbar">bar</a>')
    expect(text).toContain('<a href="/?path=foo%2Fbar%2Fbaz">baz</a>')
  })

  it("should redirect to /file when file is selected", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "hello.txt"), "hello world")
    const req = new Request("http://localhost/?path=hello.txt", {
      method: "GET",
      redirect: "manual",
    })
    const res = await app.request(req)
    // 302リダイレクト
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/file?path=hello.txt")
  })
})

describe("file endpoint /file", () => {
  const UPLOAD_DIR = "./tmp-test"
  beforeEach(async () => {
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {}
    await mkdir(UPLOAD_DIR, { recursive: true })
    process.env.UPLOAD_DIR = UPLOAD_DIR
  })
  afterEach(async () => {
    try {
      await rm(UPLOAD_DIR, { recursive: true, force: true })
    } catch (_error) {}
  })

  it("should render file content as <pre>", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "readme.md"), "# Hello\nworld")
    const req = new Request("http://localhost/file?path=readme.md", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("# Hello")
    expect(text).toContain("<pre>")
  })

  it("should return error for non-existent file", async () => {
    const req = new Request("http://localhost/file?path=notfound.txt", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.success).toBe(false)
    expect(data.error).toBeDefined()
    expect(data.error.name).toBe("NotFound")
  })

  it("should return error for directory path", async () => {
    await mkdir(path.join(UPLOAD_DIR, "dir1"))
    const req = new Request("http://localhost/file?path=dir1", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.success).toBe(false)
    expect(data.error).toBeDefined()
    expect(data.error.name).toBe("NotAFile")
  })
})
