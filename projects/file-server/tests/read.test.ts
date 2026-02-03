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
    const responseData = (await res.json()) as {
      files: Array<{ name: string; type: "file" | "dir"; size?: number }>
    }
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
    const responseData = (await res.json()) as {
      files: Array<{ name: string; type: "file" | "dir"; size?: number }>
    }
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
    const responseData = (await res.json()) as {
      files: Array<{ name: string; type: "file" | "dir"; size?: number }>
    }
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
    const responseData = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
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
    // htmx属性があることを確認
    expect(text).toContain("hx-get")
    expect(text).toContain("hx-target")
    expect(text).toContain("hx-push-url")
    expect(text).toContain('id="file-list-container"')
    // ファイルリンクはfile-viewer-containerをターゲットにする
    expect(text).toContain('hx-target="#file-viewer-container"')
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
    // パンくずリストの各階層リンクが含まれること（htmx属性付き）
    expect(text).toContain('href="/"')
    expect(text).toContain('href="/?path=foo"')
    expect(text).toContain('href="/?path=foo%2Fbar"')
    expect(text).toContain('href="/?path=foo%2Fbar%2Fbaz"')
    // パンくずリストにテキストとしてroot/foo/bar/bazがある
    expect(text).toContain(">root</a>")
    expect(text).toContain(">foo</a>")
    expect(text).toContain(">bar</a>")
    expect(text).toContain(">baz</a>")
    // htmx属性があることを確認
    expect(text).toContain('hx-get="/browse?path="')
    expect(text).toContain('hx-get="/browse?path=foo"')
    expect(text).toContain('hx-target="#file-list-container"')
    expect(text).toContain("hx-push-url")
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

  it("should return partial HTML for htmx request to /", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "htmx-test.txt"), "htmx content")
    const req = new Request("http://localhost/?path=", {
      method: "GET",
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    // 部分HTML（フルページシェルではない）
    expect(text).toContain("htmx-test.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")
    expect(text).not.toContain("<head>")
    expect(text).not.toContain("<title>File Server</title>")
    expect(text).not.toContain("htmx.min.js")
  })

  it("should return partial HTML for htmx request to nested directory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "htmx/nested"), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, "htmx/nested", "file.txt"), "nested")
    const req = new Request("http://localhost/?path=htmx%2Fnested", {
      method: "GET",
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("file.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("htmx") // パンくずリストにhtmxが含まれる
    expect(text).not.toContain("<html")
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
    expect(text).toMatch(/<pre[^>]*>/)
    expect(text).toContain('id="file-viewer-container"')
    expect(text).toContain("<html") // 通常リクエストはフルHTML
    expect(text).toContain("✕ Close")
  })

  it("should render file content as partial HTML for htmx request", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "htmx-file.txt"), "htmx file content")
    const req = new Request("http://localhost/file?path=htmx-file.txt", {
      method: "GET",
      headers: { "HX-Request": "true" },
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx file content")
    expect(text).toMatch(/<pre[^>]*>/)
    expect(text).toContain('id="file-viewer-container"')
    expect(text).not.toContain("<html") // htmxリクエストは部分HTML
    expect(text).not.toContain("<head>")
    expect(text).toContain("✕ Close")
  })

  it("should return error for non-existent file", async () => {
    const req = new Request("http://localhost/file?path=notfound.txt", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
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
    const data = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(data.success).toBe(false)
    expect(data.error).toBeDefined()
    expect(data.error.name).toBe("NotAFile")
  })
})

describe("browse endpoint /browse (htmx)", () => {
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

  it("should return directory listing as partial HTML", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "browse-test.txt"), "test")
    const req = new Request("http://localhost/browse?path=", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("browse-test.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html") // /browseは常に部分HTML
    expect(text).not.toContain("<head>")
    expect(text).toContain('hx-get="/file?path=browse-test.txt"')
    expect(text).toContain('hx-target="#file-viewer-container"')
    expect(text).toContain('hx-push-url="/file?path=browse-test.txt"')
  })

  it("should return nested directory listing", async () => {
    await mkdir(path.join(UPLOAD_DIR, "browse/nested"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "browse/nested", "nested.txt"),
      "nested content",
    )
    const req = new Request("http://localhost/browse?path=browse%2Fnested", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("nested.txt")
    expect(text).toContain("browse") // パンくずリストにbrowseが含まれる
    expect(text).toContain("nested") // パンくずリストにnestedが含まれる
    expect(text).toContain('hx-get="/browse?path=browse%2Fnested"')
  })

  it("should return error for non-existent directory", async () => {
    const req = new Request("http://localhost/browse?path=nonexistent", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotFound")
  })

  it("should return error for file path", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "file-only.txt"), "content")
    const req = new Request("http://localhost/browse?path=file-only.txt", {
      method: "GET",
    })
    const res = await app.request(req)
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotADirectory")
  })
})
