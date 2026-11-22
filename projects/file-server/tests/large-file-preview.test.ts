import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { rm } from "node:fs/promises"
import * as path from "node:path"
import {
  MAX_INLINE_TEXT_BYTES,
  TEXT_EXCERPT_BYTES,
} from "../src/utils/filePreviewLimits"
import { createTestApp } from "./helpers/createTestApp"

const HEAD_MARKER = "HEAD-MARKER"
const TAIL_MARKER = "TAIL-MARKER"

const head = (prefix = "") => `${prefix}${HEAD_MARKER}\n`

function oversizedBody(line: string, repeat = MAX_INLINE_TEXT_BYTES + 1) {
  return `${head()}${line.repeat(repeat)}${TAIL_MARKER}\n`
}

async function getViewer(
  app: Awaited<ReturnType<typeof createTestApp>>,
  requestPath: string,
  query = "",
) {
  const res = await app.request(
    new Request(
      `http://localhost/file?path=${encodeURIComponent(requestPath)}${query}`,
      { headers: { "HX-Request": "true" } },
    ),
  )
  return { res, text: await res.text() }
}

describe("GET /file - oversized text files", () => {
  const UPLOAD_DIR = "./tmp-test-large-file"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("shows only the head with a notice instead of the whole file", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "big.log"),
      oversizedBody("A"),
    )

    const { res, text } = await getViewer(app, "private/big.log")

    expect(res.status).toBe(200)
    expect(text).toContain(HEAD_MARKER)
    expect(text).not.toContain(TAIL_MARKER)
    expect(text).toContain("only the first 64 KB is shown")
    // The bounded response is what keeps weak clients responsive.
    expect(text.length).toBeLessThan(MAX_INLINE_TEXT_BYTES)
  })

  it("links to the streamed full text and disables copy and edit", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "big.log"),
      oversizedBody("A"),
    )

    const { text } = await getViewer(app, "private/big.log")

    expect(text).toContain('href="/file/raw?path=private%2Fbig.log"')
    expect(text).toContain("Open full text")
    expect(text).not.toContain('id="file-viewer-copy-button"')
    expect(text).not.toContain('title="Copy all"')
    expect(text).not.toContain('title="Edit"')
  })

  it("rejects the edit view for an oversized file", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "big.log"),
      oversizedBody("A"),
    )

    const { text } = await getViewer(app, "private/big.log", "&edit=true")

    expect(text).not.toContain("<textarea")
    expect(text).toContain("only the first 64 KB is shown")
  })

  it("offers the rendered preview but not raw text for oversized HTML", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "big.html"),
      oversizedBody("<p>A</p>"),
    )

    const { text } = await getViewer(app, "private/big.html")

    expect(text).toContain('title="Preview"')
    expect(text).toContain(`href="/file/preview/private/big.html"`)
    // /file/raw refuses active content, so there is nothing to link to.
    expect(text).not.toContain("Open full text")
  })

  it("still shows files at or below the limit in full", async () => {
    const body = `${head()}${"B".repeat(MAX_INLINE_TEXT_BYTES - head().length)}`
    await Bun.write(path.join(UPLOAD_DIR, "private", "fits.log"), body)

    const { text } = await getViewer(app, "private/fits.log")

    expect(text).toContain("B".repeat(MAX_INLINE_TEXT_BYTES - head().length))
    expect(text).toContain('id="file-viewer-copy-button"')
    expect(text).toContain('title="Edit"')
    expect(text).not.toContain("only the first")
  })

  it("cuts multi-byte characters at a character boundary", async () => {
    // TEXT_EXCERPT_BYTES is not a multiple of 3, so the byte cut lands in the
    // middle of a UTF-8 sequence.
    expect(TEXT_EXCERPT_BYTES % 3).not.toBe(0)
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "jp.log"),
      "あ".repeat(MAX_INLINE_TEXT_BYTES),
    )

    const { text } = await getViewer(app, "private/jp.log")

    expect(text).not.toContain("\uFFFD")
    expect(text).toContain("あ")
  })

  it("serves the whole oversized file from /file/raw", async () => {
    const body = oversizedBody("A")
    await Bun.write(path.join(UPLOAD_DIR, "private", "big.log"), body)

    const res = await app.request(
      new Request("http://localhost/file/raw?path=private%2Fbig.log"),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("Content-Length")).toBe(
      String(Buffer.byteLength(body)),
    )
    expect(await res.text()).toBe(body)
  })
})

describe("GET /file/preview/* - oversized markdown", () => {
  const UPLOAD_DIR = "./tmp-test-large-markdown"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("shows the head and a download link instead of parsing the file", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "big.md"),
      `${head("# ")}${"- item\n".repeat(MAX_INLINE_TEXT_BYTES)}${TAIL_MARKER}\n`,
    )

    const res = await app.request(
      new Request("http://localhost/file/preview/private/big.md"),
    )
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain(HEAD_MARKER)
    expect(text).not.toContain(TAIL_MARKER)
    expect(text).toContain("only the first 64 KB is shown")
    expect(text).toContain('href="/file/download?path=private%2Fbig.md"')
    // The excerpt ends mid-document, so it must not be rendered as Markdown.
    expect(text).not.toContain("<h1>")
    expect(text.length).toBeLessThan(MAX_INLINE_TEXT_BYTES)
  })
})
