import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, rm } from "node:fs/promises"
import * as path from "node:path"
import { createTestApp } from "./helpers/createTestApp"

describe("upload", () => {
  const UPLOAD_DIR = "./tmp-test-upload"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("should upload a single file to the public scope", async () => {
    const testContent = "Hello, World!"
    const formData = new FormData()
    formData.append(
      "files",
      new File([testContent], "test.txt", { type: "text/plain" }),
    )
    formData.append("path", "public")

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: { name: string; reason: string }[]
    }
    expect(data.success).toBe(true)
    expect(data.uploaded).toContain("test.txt")
    expect(data.failed).toHaveLength(0)

    const savedContent = await readFile(
      path.join(UPLOAD_DIR, "public", "test.txt"),
      "utf-8",
    )
    expect(savedContent).toBe(testContent)
  })

  it("should upload multiple files", async () => {
    const formData = new FormData()
    formData.append(
      "files",
      new File(["Content 1"], "file1.txt", { type: "text/plain" }),
    )
    formData.append(
      "files",
      new File(["Content 2"], "file2.txt", { type: "text/plain" }),
    )
    formData.append("path", "public")

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: unknown[]
    }
    expect(data.success).toBe(true)
    expect(data.uploaded).toHaveLength(2)
    expect(data.uploaded).toContain("file1.txt")
    expect(data.uploaded).toContain("file2.txt")
    expect(data.failed).toHaveLength(0)

    expect(
      await readFile(path.join(UPLOAD_DIR, "public", "file1.txt"), "utf-8"),
    ).toBe("Content 1")
    expect(
      await readFile(path.join(UPLOAD_DIR, "public", "file2.txt"), "utf-8"),
    ).toBe("Content 2")
  })

  it("should upload files to nested directory", async () => {
    const testContent = "Nested Hello!"
    const nestedPath = "public/foo/bar/baz.txt"
    const formData = new FormData()
    formData.append(
      "files",
      new File([testContent], "baz.txt", { type: "text/plain" }),
    )
    formData.append("path", nestedPath)

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { success: boolean; uploaded: string[] }
    expect(data.success).toBe(true)
    expect(data.uploaded).toContain("baz.txt")

    const savedContent = await readFile(
      path.join(UPLOAD_DIR, nestedPath),
      "utf-8",
    )
    expect(savedContent).toBe(testContent)
  })

  it("should upload files to a directory path (with trailing slash)", async () => {
    const testContent = "Dir Hello!"
    const dirPath = "public/dir1/dir2/"
    const formData = new FormData()
    formData.append(
      "files",
      new File([testContent], "uploaded.txt", { type: "text/plain" }),
    )
    formData.append("path", dirPath)

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { success: boolean; uploaded: string[] }
    expect(data.success).toBe(true)
    expect(data.uploaded).toContain("uploaded.txt")

    const savedContent = await readFile(
      path.join(UPLOAD_DIR, "public/dir1/dir2/uploaded.txt"),
      "utf-8",
    )
    expect(savedContent).toBe(testContent)
  })

  it("should return empty result when no file is uploaded", async () => {
    const formData = new FormData()
    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      success: boolean
      uploaded: string[]
      failed: unknown[]
    }
    expect(data.success).toBe(true)
    expect(data.uploaded).toHaveLength(0)
    expect(data.failed).toHaveLength(0)
  })

  it("should reject upload to parent directory path", async () => {
    const formData = new FormData()
    formData.append(
      "files",
      new File(["content"], "evil.txt", { type: "text/plain" }),
    )
    formData.append("path", "../../evil.txt")

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      }),
    )
    expect(res.status).toBe(403)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("Forbidden")
  })

  it("should upload files via htmx and return HTML with file list", async () => {
    const testContent = "Hello htmx!"
    const formData = new FormData()
    formData.append(
      "files",
      new File([testContent], "htmx-test.txt", { type: "text/plain" }),
    )
    formData.append("path", "public")

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
        headers: { "HX-Request": "true" },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx-test.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")

    const savedContent = await readFile(
      path.join(UPLOAD_DIR, "public", "htmx-test.txt"),
      "utf-8",
    )
    expect(savedContent).toBe(testContent)
  })

  it("should upload multiple files via htmx", async () => {
    const formData = new FormData()
    formData.append(
      "files",
      new File(["Content 1"], "htmx-multi1.txt", { type: "text/plain" }),
    )
    formData.append(
      "files",
      new File(["Content 2"], "htmx-multi2.txt", { type: "text/plain" }),
    )
    formData.append("path", "public")

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
        headers: { "HX-Request": "true" },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("htmx-multi1.txt")
    expect(text).toContain("htmx-multi2.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")
  })

  it("should upload files to nested directory via htmx", async () => {
    await mkdir(path.join(UPLOAD_DIR, "public/htmx/foo"), { recursive: true })

    const testContent = "Nested htmx!"
    const formData = new FormData()
    formData.append(
      "files",
      new File([testContent], "bar.txt", { type: "text/plain" }),
    )
    formData.append("path", "public/htmx/foo/")

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
        headers: { "HX-Request": "true" },
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("bar.txt")
    expect(text).toContain('id="file-list-container"')
    expect(text).not.toContain("<html")

    const savedContent = await readFile(
      path.join(UPLOAD_DIR, "public/htmx/foo/bar.txt"),
      "utf-8",
    )
    expect(savedContent).toBe(testContent)
  })

  it("should reject more than 10 files", async () => {
    const formData = new FormData()
    for (let i = 0; i < 11; i++) {
      formData.append(
        "files",
        new File([`Content ${i}`], `file${i}.txt`, { type: "text/plain" }),
      )
    }

    const res = await app.request(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: formData,
      }),
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as {
      success: boolean
      error: { name: string; message: string }
    }
    expect(data.success).toBe(false)
    expect(data.error.name).toBe("ZodError")
    expect(data.error.message).toContain("Too big")
  })
})
