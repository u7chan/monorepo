import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import * as path from "node:path"
import { createTestSession } from "./helpers/auth"
import { createTestApp } from "./helpers/createTestApp"

const SESSION_SECRET = "test-secret-for-preview"

describe("GET /file/preview/* - sandboxed active content", () => {
  const UPLOAD_DIR = "./tmp-test-preview"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("serves private HTML with a sandbox CSP", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "report.html"),
      "<html><body>rendered</body></html>",
    )
    const res = await app.request(
      new Request("http://localhost/file/preview/private/report.html"),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "sandbox allow-scripts",
    )
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await res.text()).toContain("rendered")
  })

  it("decodes percent-encoded path segments", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "日本語 レポート.html"),
      "<html><body>日本語</body></html>",
    )
    const res = await app.request(
      new Request(
        `http://localhost/file/preview/private/${encodeURIComponent("日本語 レポート.html")}`,
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("日本語")
  })

  it("serves sibling assets so relative URLs resolve", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private", "site"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "site", "index.html"),
      '<html><head><link rel="stylesheet" href="style.css"></head></html>',
    )
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "site", "style.css"),
      "body { color: red; }",
    )
    const res = await app.request(
      new Request("http://localhost/file/preview/private/site/style.css"),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8")
    // Only documents need the sandbox; a stylesheet response has no browsing context.
    expect(res.headers.get("Content-Security-Policy")).toBeNull()
    expect(await res.text()).toContain("color: red")
  })

  it("sandboxes SVG previews as well", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "chart.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
    const res = await app.request(
      new Request("http://localhost/file/preview/private/chart.svg"),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8")
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "sandbox allow-scripts",
    )
  })

  it("returns 400 for a missing file", async () => {
    const res = await app.request(
      new Request("http://localhost/file/preview/private/missing.html"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { name: string } }
    expect(data.error.name).toBe("NotFound")
  })

  it("returns 400 for a directory", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private", "docs"), { recursive: true })
    const res = await app.request(
      new Request("http://localhost/file/preview/private/docs"),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { name: string } }
    expect(data.error.name).toBe("NotAFile")
  })

  it("rejects an encoded traversal segment", async () => {
    const res = await app.request(
      new Request(
        "http://localhost/file/preview/private/..%2f..%2fsecret.html",
      ),
    )
    expect(res.status).toBe(403)
    const data = (await res.json()) as { error: { name: string } }
    expect(data.error.name).toBe("Forbidden")
  })

  it("serves public active content with the same sandbox", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "page.html"),
      "<html><body>public</body></html>",
    )
    const res = await app.request(
      new Request("http://localhost/file/preview/public/page.html"),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "sandbox allow-scripts",
    )
  })
})

describe("GET /file - preview entry point", () => {
  const UPLOAD_DIR = "./tmp-test-preview-entry"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("links private HTML to the sandboxed preview route", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private", "site"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "site", "レポート.html"),
      "<html><body>hello</body></html>",
    )
    const res = await app.request(
      new Request(
        `http://localhost/file?path=${encodeURIComponent("private/site/レポート.html")}`,
        { headers: { "HX-Request": "true" } },
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain(
      `href="/file/preview/private/site/${encodeURIComponent("レポート.html")}"`,
    )
    expect(text).toContain('title="Preview"')
    expect(text).not.toContain('href="/private/')
  })

  it("keeps the public URL link for public HTML and adds no preview link", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "public", "page.html"),
      "<html><body>public</body></html>",
    )
    const res = await app.request(
      new Request("http://localhost/file?path=public%2Fpage.html", {
        headers: { "HX-Request": "true" },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('href="/public/page.html"')
    expect(text).not.toContain("/file/preview/")
  })

  it("does not offer a preview link for non-active content", async () => {
    await Bun.write(path.join(UPLOAD_DIR, "public", "note.txt"), "plain text")
    const res = await app.request(
      new Request("http://localhost/file?path=public%2Fnote.txt", {
        headers: { "HX-Request": "true" },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('title="Preview"')
  })
})

describe("GET /file/preview/* - with auth", () => {
  const UPLOAD_DIR = "./tmp-test-preview-auth"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({
      uploadDir: UPLOAD_DIR,
      sessionSecret: SESSION_SECRET,
      seedUsers: [
        { username: "admin", password: "pass", role: "admin" },
        { username: "alice", password: "pass", role: "user" },
      ],
    })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("allows a user to preview their own HTML", async () => {
    const session = await createTestSession("alice", SESSION_SECRET)
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "alice", "report.html"),
      "<html><body>mine</body></html>",
    )
    const res = await app.request(
      new Request("http://localhost/file/preview/private/alice/report.html", {
        headers: { Cookie: session.cookie },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("mine")
  })

  it("denies previewing another user's HTML", async () => {
    const session = await createTestSession("alice", SESSION_SECRET)
    await mkdir(path.join(UPLOAD_DIR, "private", "admin"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "admin", "secret.html"),
      "<html><body>secret</body></html>",
    )
    const res = await app.request(
      new Request("http://localhost/file/preview/private/admin/secret.html", {
        headers: { Cookie: session.cookie },
      }),
    )
    expect(res.status).toBe(403)
  })

  it("redirects anonymous requests to the login page", async () => {
    await mkdir(path.join(UPLOAD_DIR, "private", "alice"), { recursive: true })
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "alice", "report.html"),
      "<html><body>mine</body></html>",
    )
    const res = await app.request(
      new Request("http://localhost/file/preview/private/alice/report.html"),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("Location") ?? "").toStartWith("/login")
  })
})
