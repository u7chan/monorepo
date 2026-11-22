import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { writeFileAtomic } from "../src/utils/atomicWrite"
import {
  MAX_INLINE_TEXT_BYTES,
  readTextPreview,
  TEXT_EXCERPT_BYTES,
} from "../src/utils/filePreviewLimits"
import { readFileResponse } from "../src/utils/fileRouteUtils"
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

    expect(text).toContain('href="/file/raw?path=private%2Fbig.log&amp;as=text"')
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

  it("bounds the viewer after oversized content is saved", async () => {
    const filePath = path.join(UPLOAD_DIR, "private", "paste.txt")
    await Bun.write(filePath, "small")
    // Why no newline: multipart parsing normalizes them to CRLF.
    const content = `${HEAD_MARKER}${"A".repeat(MAX_INLINE_TEXT_BYTES)}${TAIL_MARKER}`

    const formData = new FormData()
    formData.append("path", "private/paste.txt")
    formData.append("content", content)
    const res = await app.request(
      new Request("http://localhost/api/update", {
        method: "POST",
        body: formData,
        headers: { "HX-Request": "true" },
      }),
    )
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain(HEAD_MARKER)
    expect(text).not.toContain(TAIL_MARKER)
    expect(text).not.toContain("<textarea")
    expect(text).toContain("only the first 64 KB is shown")
    expect(text.length).toBeLessThan(MAX_INLINE_TEXT_BYTES)
    // The saved file still holds every submitted byte.
    expect(await readFile(filePath, "utf-8")).toBe(content)
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

describe("readTextPreview - bounded reads", () => {
  const UPLOAD_DIR = "./tmp-test-bounded-read"
  let filePath: string

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    await Bun.write(path.join(UPLOAD_DIR, ".keep"), "")
    filePath = path.join(UPLOAD_DIR, "grew.txt")
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("decides from the bytes read, not from an earlier stat", async () => {
    // The route no longer takes a size from stat before reading; simulate a
    // file that was small when the request began and grew before the read.
    await writeFile(filePath, "small")
    await writeFile(filePath, "A".repeat(MAX_INLINE_TEXT_BYTES + 10))

    const preview = await readTextPreview(filePath)

    expect(preview.truncated).toBe(true)
    expect(preview.size).toBe(MAX_INLINE_TEXT_BYTES + 10)
    expect(preview.content).toHaveLength(TEXT_EXCERPT_BYTES)
  })

  it("keeps a file at the limit fully readable", async () => {
    const body = "B".repeat(MAX_INLINE_TEXT_BYTES)
    await writeFile(filePath, body)

    const preview = await readTextPreview(filePath)

    expect(preview.truncated).toBe(false)
    expect(preview.size).toBe(MAX_INLINE_TEXT_BYTES)
    expect(preview.content).toBe(body)
  })
})

describe("readFileResponse - streaming and atomic publish", () => {
  const UPLOAD_DIR = "./tmp-test-stream"
  let filePath: string

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    await Bun.write(path.join(UPLOAD_DIR, ".keep"), "")
    filePath = path.join(UPLOAD_DIR, "during-download.bin")
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("finishes with the opened bytes when the file is replaced mid-response", async () => {
    const original = Buffer.alloc(1024 * 1024, 0x41)
    await writeFile(filePath, original)

    const res = await readFileResponse(filePath, {
      "Content-Type": "application/octet-stream",
    })
    expect(res.headers.get("Content-Length")).toBe(String(original.length))

    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    const chunks: Uint8Array[] = []
    const first = await reader?.read()
    expect(first?.done).toBe(false)
    if (first?.value) chunks.push(first.value)

    await writeFileAtomic(filePath, "replaced")
    expect(await readFile(filePath, "utf-8")).toBe("replaced")

    let done = false
    while (!done) {
      const result = await reader?.read()
      done = result?.done ?? true
      if (result?.value) chunks.push(result.value)
    }

    expect(Buffer.concat(chunks)).toEqual(original)
  })

  it("serves an empty file with a zero length", async () => {
    await writeFile(filePath, "")

    const res = await readFileResponse(filePath, {
      "Content-Type": "application/octet-stream",
    })

    expect(res.headers.get("Content-Length")).toBe("0")
    expect(await res.text()).toBe("")
  })
})

describe("GET /file/raw - as=text", () => {
  const UPLOAD_DIR = "./tmp-test-raw-as-text"
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
    app = await createTestApp({ uploadDir: UPLOAD_DIR })
  })

  afterEach(async () => {
    await rm(UPLOAD_DIR, { recursive: true, force: true })
  })

  it("serves .mdown as inline plain text", async () => {
    const body = oversizedBody("- item\n")
    await Bun.write(path.join(UPLOAD_DIR, "private", "notes.mdown"), body)

    const res = await app.request(
      new Request(
        "http://localhost/file/raw?path=private%2Fnotes.mdown&as=text",
      ),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8")
    expect(await res.text()).toBe(body)
  })

  it("keeps the extension MIME type without as=text", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "notes.mdown"),
      oversizedBody("- item\n"),
    )

    const res = await app.request(
      new Request("http://localhost/file/raw?path=private%2Fnotes.mdown"),
    )

    expect(res.headers.get("Content-Type")).toBe("application/octet-stream")
    // Why consume: the body streams from an open handle, which closes when the
    // stream ends.
    await res.arrayBuffer()
  })

  it("still refuses active content with as=text", async () => {
    await Bun.write(
      path.join(UPLOAD_DIR, "private", "page.html"),
      oversizedBody("<p>A</p>"),
    )

    const res = await app.request(
      new Request("http://localhost/file/raw?path=private%2Fpage.html&as=text"),
    )

    expect(res.status).toBe(403)
    const data = (await res.json()) as { error: { name: string } }
    expect(data.error.name).toBe("ActiveContentNotAllowed")
  })
})
