import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import * as path from "node:path"
import { createTestApp } from "./helpers/createTestApp"

const zipAvailable = Bun.spawnSync(["which", "zip"]).exitCode === 0

function zipBodyText(body: ArrayBuffer): string {
  return Buffer.from(body).toString("latin1")
}

describe("read - API listing", () => {
  const UPLOAD_DIR = "./tmp-test-read"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("should return synthetic root entries [public, private]", async () => {
    const res = await app.request(new Request("http://localhost/api/"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      files: Array<{ name: string; type: "file" | "dir" }>
    }
    expect(data.files).toEqual(
      expect.arrayContaining([
        { name: "public", type: "dir" },
        { name: "private", type: "dir" },
      ]),
    )
    expect(data.files).toHaveLength(2)
  })

  it("should return empty files list in public when directory is empty", async () => {
    const res = await app.request(new Request("http://localhost/api/public"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as { files: Array<unknown> }
    expect(data.files).toEqual([])
  })

  it("should return files in public directory", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "test1.txt"),
      "Hello, World!",
    )
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "test2.txt"),
      "Test content",
    )

    const res = await app.request(new Request("http://localhost/api/public"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      files: Array<{ name: string; type: "file" | "dir"; size?: number }>
    }
    expect(data.files).toEqual(
      expect.arrayContaining([
        { name: "test1.txt", type: "file", size: 13 },
        { name: "test2.txt", type: "file", size: 12 },
      ]),
    )
    expect(data.files).toHaveLength(2)
  })

  it("should return files in subdirectory when subpath is specified", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public/foo/bar"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "public/foo/bar", "baz.txt"),
      "baz content",
    )
    await Bun.write(
      path.join(UPLOAD_DIR, "public/foo/bar", "qux.txt"),
      "qux content",
    )

    const res = await app.request(
      new Request("http://localhost/api/public/foo/bar"),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      files: Array<{ name: string; type: "file" | "dir"; size?: number }>
    }
    expect(data.files).toEqual(
      expect.arrayContaining([
        { name: "baz.txt", type: "file", size: 11 },
        { name: "qux.txt", type: "file", size: 11 },
      ]),
    )
    expect(data.files).toHaveLength(2)
  })

  it("should return error for non-existent directory", async () => {
    const res = await app.request(
      new Request("http://localhost/api/public/nonexistent"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("DirNotFound")
  })
})

describe("browse endpoint /", () => {
  const UPLOAD_DIR = "./tmp-test-browse"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("should render root as synthetic [public, private]", async () => {
    const res = await app.request(new Request("http://localhost/?path="))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("public")
    expect(text).toContain("private")
    expect(text).toContain('id="file-list-container"')
  })

  it("should render directory listing in public scope as HTML", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "public", "foo.txt"), "foo content")
    await Bun.write(path.join(UPLOAD_DIR, "public", "bar.txt"), "bar content")

    const res = await app.request(new Request("http://localhost/?path=public"))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("foo.txt")
    expect(text).toContain("bar.txt")
    expect(text).toContain("<a href")
    expect(text).toContain("hx-get")
    expect(text).toContain('id="file-list-container"')
    expect(text).toContain("New File")
  })

  it("should render breadcrumb navigation in directory listing", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public/foo/bar/baz"), {
      recursive: true,
    })

    const res = await app.request(
      new Request("http://localhost/?path=public%2Ffoo%2Fbar%2Fbaz"),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('href="/"')
    expect(text).toContain('href="/?path=public"')
    expect(text).toContain('href="/?path=public%2Ffoo"')
    expect(text).toContain('href="/?path=public%2Ffoo%2Fbar"')
    expect(text).toContain('href="/?path=public%2Ffoo%2Fbar%2Fbaz"')
    expect(text).toContain(">public</a>")
    expect(text).toContain(">foo</a>")
    expect(text).toContain(">bar</a>")
    expect(text).toContain(">baz</a>")
  })

  it("should render directory zip download link", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public/foo/bar"), { recursive: true })

    const res = await app.request(
      new Request("http://localhost/?path=public%2Ffoo%2Fbar"),
    )
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('href="/file/archive?path=public%2Ffoo%2Fbar"')
    expect(text).toContain("Download Zip")
  })

  it("should redirect to /file when file is selected", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "public", "hello.txt"), "hello world")

    const res = await app.request(
      new Request("http://localhost/?path=public%2Fhello.txt", {
        redirect: "manual",
      }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/file?path=public%2Fhello.txt")
  })

  it("should return partial HTML for htmx request", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "htmx-test.txt"),
      "htmx content",
    )

    const res = await app.request(
      new Request("http://localhost/?path=public", {
        headers: { "HX-Request": "true" },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx-test.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")
    expect(text).not.toContain("<head>")
    expect(text).not.toContain("htmx.min.js")
  })

  it("should return 404 for non-existent path", async () => {
    const res = await app.request(
      new Request("http://localhost/?path=public%2Fnonexistent"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotFound")
  })
})

describe("file endpoint /file", () => {
  const UPLOAD_DIR = "./tmp-test-file"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("should redirect to parent directory on non-htmx request", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "readme.md"),
      "# Hello\nworld",
    )

    const res = await app.request(
      new Request("http://localhost/file?path=public%2Freadme.md"),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/?path=public")
  })

  it("should redirect to parent directory for nested file", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "subdir"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "public/subdir/nested.txt"),
      "nested content",
    )

    const res = await app.request(
      new Request("http://localhost/file?path=public%2Fsubdir%2Fnested.txt"),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/?path=public%2Fsubdir")
  })

  it("should render file content as partial HTML for htmx request", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "htmx-file.txt"),
      "htmx file content",
    )

    const res = await app.request(
      new Request("http://localhost/file?path=public%2Fhtmx-file.txt", {
        headers: { "HX-Request": "true" },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx file content")
    expect(text).toMatch(/<pre[^>]*>/)
    expect(text).toContain('id="file-viewer-container"')
    expect(text).not.toContain("<html")
    expect(text).not.toContain("<head>")
  })

  it("should return error for non-existent file", async () => {
    const res = await app.request(
      new Request("http://localhost/file?path=public%2Fnotfound.txt"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotFound")
  })

  it("should return error for directory path", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "dir1"))

    const res = await app.request(
      new Request("http://localhost/file?path=public%2Fdir1"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotAFile")
  })
})

describe("file archive endpoint /file/archive", () => {
  const UPLOAD_DIR = "./tmp-test-archive"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("should return a zip archive for the public directory", async () => {
    if (!zipAvailable) return

    await mkdir(path.join(UPLOAD_DIR, "public", "nested"), { recursive: true })
    await Bun.write(path.join(UPLOAD_DIR, "public", "foo.txt"), "foo")
    await Bun.write(path.join(UPLOAD_DIR, "public", "nested", "bar.txt"), "bar")

    const res = await app.request(
      new Request("http://localhost/file/archive?path=public"),
    )
    const body = await res.arrayBuffer()
    const zipText = zipBodyText(body)

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/zip")
    expect(res.headers.get("Content-Disposition")).toContain("public.zip")
    expect(zipText).toContain("PK\u0003\u0004")
    expect(zipText).toContain("foo.txt")
    expect(zipText).toContain("nested/")
    expect(zipText).toContain("nested/bar.txt")
  })

  it("should return a zip archive for a nested directory", async () => {
    if (!zipAvailable) return

    await mkdir(path.join(UPLOAD_DIR, "public/docs/images"), {
      recursive: true,
    })
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "docs", "readme.md"),
      "# docs",
    )
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "docs/images", "logo.txt"),
      "logo",
    )

    const res = await app.request(
      new Request("http://localhost/file/archive?path=public%2Fdocs"),
    )
    const body = await res.arrayBuffer()
    const zipText = zipBodyText(body)

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Disposition")).toContain("docs.zip")
    expect(zipText).toContain("readme.md")
    expect(zipText).toContain("images/")
    expect(zipText).not.toContain("docs/readme.md")
  })

  it("should return an empty zip archive for an empty directory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public", "empty"), { recursive: true })

    const res = await app.request(
      new Request("http://localhost/file/archive?path=public%2Fempty"),
    )
    const body = await res.arrayBuffer()
    const zipText = zipBodyText(body)

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Disposition")).toContain("empty.zip")
    expect(zipText).toContain("PK\u0005\u0006")
  })

  it("should return error for file path on archive endpoint", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "public", "file-only.txt"), "content")

    const res = await app.request(
      new Request("http://localhost/file/archive?path=public%2Ffile-only.txt"),
    )
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }

    expect(res.status).toBe(400)
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotADirectory")
  })

  it("should reject path traversal on archive endpoint", async () => {
    const res = await app.request(
      new Request("http://localhost/file/archive?path=../secret"),
    )
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }

    expect(res.status).toBe(403)
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("Forbidden")
  })
})

describe("browse endpoint /browse (htmx)", () => {
  const UPLOAD_DIR = "./tmp-test-htmx-browse"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("should return synthetic root listing as partial HTML", async () => {
    const res = await app.request(new Request("http://localhost/browse?path="))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("public")
    expect(text).toContain("private")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")
  })

  it("should return public directory listing as partial HTML", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "public", "browse-test.txt"), "test")

    const res = await app.request(
      new Request("http://localhost/browse?path=public"),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("browse-test.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")
    expect(text).not.toContain("<head>")
  })

  it("should return nested directory listing", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public/browse/nested"), {
      recursive: true,
    })
    await Bun.write(
      path.join(UPLOAD_DIR, "public/browse/nested", "nested.txt"),
      "nested content",
    )

    const res = await app.request(
      new Request("http://localhost/browse?path=public%2Fbrowse%2Fnested"),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("nested.txt")
    expect(text).toContain("browse")
    expect(text).toContain("nested")
  })

  it("should return error for non-existent directory", async () => {
    const res = await app.request(
      new Request("http://localhost/browse?path=public%2Fnonexistent"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotFound")
  })

  it("should return error for file path", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "public", "file-only.txt"), "content")

    const res = await app.request(
      new Request("http://localhost/browse?path=public%2Ffile-only.txt"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("NotADirectory")
  })
})
