import type { Stats } from "node:fs"
import { stat as fsStat, readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import type { Context } from "hono"
import type { AppBindings } from "../types"
import { lookupMimeType, normalizeResponseMimeType } from "./mimeType"
import { isNodeErrorCode } from "./nodeError"
import {
  errorResponse,
  forbiddenResponse,
  getRequestPath,
  getUploadDir,
  getUser,
} from "./requestUtils"
import { resolveVirtualPath } from "./virtualPath"

const ACTIVE_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
])

const ACTIVE_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".svg"])

const MARKDOWN_MIME_TYPES = new Set(["text/markdown", "text/x-markdown"])

const MARKDOWN_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".mkdn",
])

/**
 * The preview route shares the app origin, so the rendered document has to run
 * in an opaque origin. `allow-same-origin` is deliberately omitted: with it the
 * page could call the authenticated API with the viewer's cookies, which is
 * exactly why `/file/raw` refuses to serve active content.
 */
export const ACTIVE_CONTENT_PREVIEW_CSP = "sandbox allow-scripts"

export function isActiveContent(filePath: string, mimeType: string): boolean {
  if (ACTIVE_MIME_TYPES.has(mimeType)) {
    return true
  }
  const ext = path.extname(filePath).toLowerCase()
  return ACTIVE_EXTENSIONS.has(ext)
}

/**
 * 拡張子も見るのは、`mime-types` が `.mdown` / `.mkdn` を知らないため
 * (未知の拡張子は `application/octet-stream` になる)。
 */
export function isMarkdownFile(filePath: string, mimeType: string): boolean {
  if (MARKDOWN_MIME_TYPES.has(mimeType)) {
    return true
  }
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * レンダラが自分で組んだ文書なので、HTML プレビューのような sandbox は要らない。
 * ただし本文は外部由来なので、レンダラの取りこぼしに備えてスクリプトは禁止する。
 * 相対画像は同じ `/file/preview/*` を通るため `img-src 'self'` で足りる。
 */
export const MARKDOWN_PREVIEW_CSP =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

const EMPTY_ZIP_ARCHIVE = new Uint8Array([
  0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

export const isTextMime = (mimeType: string) =>
  /^text\//.test(mimeType) || /json$|javascript$|xml$/.test(mimeType)

export const isPreviewableBinary = (mimeType: string) =>
  mimeType.startsWith("image/") ||
  mimeType.startsWith("video/") ||
  mimeType === "application/pdf"

export const encodeVirtualPath = (requestPath: string) =>
  requestPath.split("/").map(encodeURIComponent).join("/")

export const toArrayBuffer = (contentBuffer: Buffer): ArrayBuffer =>
  contentBuffer.buffer.slice(
    contentBuffer.byteOffset,
    contentBuffer.byteOffset + contentBuffer.byteLength,
  ) as ArrayBuffer

export const archiveFileName = (requestPath: string) =>
  requestPath ? `${path.basename(requestPath)}.zip` : "root.zip"

const isZipCommandMissing = (message: string) =>
  message.includes('Executable not found in $PATH: "zip"')

export const archiveErrorMessage = (error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Failed to start zip command"

  if (isZipCommandMissing(message)) {
    return "Zip download is unavailable because the server does not have the zip command installed"
  }

  return message
}

export async function createDirectoryArchive(
  resolvedDir: string,
): Promise<{ body: ArrayBuffer; error: string | null }> {
  const entries = await readdir(resolvedDir)
  if (entries.length === 0) {
    return { body: EMPTY_ZIP_ARCHIVE.buffer.slice(0), error: null }
  }

  let zipProcess: ReturnType<typeof Bun.spawn>
  try {
    zipProcess = Bun.spawn(["zip", "-q", "-r", "-", ...entries], {
      cwd: resolvedDir,
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return {
      body: EMPTY_ZIP_ARCHIVE.buffer.slice(0),
      error: archiveErrorMessage(error),
    }
  }

  if (
    !(zipProcess.stdout instanceof ReadableStream) ||
    !(zipProcess.stderr instanceof ReadableStream)
  ) {
    return {
      body: EMPTY_ZIP_ARCHIVE.buffer.slice(0),
      error: "zip command did not provide readable output streams",
    }
  }

  const [body, stderr, exitCode] = await Promise.all([
    new Response(zipProcess.stdout).arrayBuffer(),
    new Response(zipProcess.stderr).text(),
    zipProcess.exited,
  ])

  if (exitCode !== 0) {
    return {
      body,
      error: stderr.trim() || `zip command failed with exit code ${exitCode}`,
    }
  }

  return { body, error: null }
}

export function decodePreviewPath(encodedPath: string): string | null {
  try {
    const segments = encodedPath
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)

    // Why not keep encoded separators: the segment split happens before
    // decoding, so `%2f` would turn into a path separator after authorization
    // looks at the user segment. A filename cannot contain "/" anyway.
    if (
      segments.some(
        (segment) =>
          segment.includes("/") ||
          segment.includes("\\") ||
          segment.includes("\0"),
      )
    ) {
      return null
    }

    return segments.join("/")
  } catch {
    return null
  }
}

export type ResolvedEntry = {
  baseDir: string
  requestPath: string
  resolvedPath: string
  responseMimeType: string
  stat: Stats
  mimeType: string
}

export type ResolveEntryOptions = {
  notFoundMessage: string
  kind: "file" | "directory"
  requestPath?: string
}

export async function resolveRequestedEntry(
  c: Context<AppBindings>,
  options: ResolveEntryOptions,
): Promise<ResolvedEntry | { response: Response }> {
  const entry = await resolveEntryAtPath(
    c,
    options.requestPath ?? getRequestPath(c),
    options.notFoundMessage,
  )
  if ("response" in entry) {
    return entry
  }

  if (options.kind === "file" && !entry.stat.isFile()) {
    return { response: notAFileResponse(c) }
  }
  if (options.kind === "directory" && !entry.stat.isDirectory()) {
    return { response: notADirectoryResponse(c) }
  }

  return entry
}

async function resolveEntryAtPath(
  c: Context<AppBindings>,
  requestPath: string,
  notFoundMessage: string,
): Promise<ResolvedEntry | { response: Response }> {
  const baseDir = getUploadDir(c)
  const user = getUser(c)

  const result = resolveVirtualPath(baseDir, user, requestPath)

  if (result.kind === "forbidden") {
    return { response: forbiddenResponse(c) }
  }
  if (result.kind === "notFound" || result.kind === "synthetic") {
    return { response: errorResponse(c, "NotFound", notFoundMessage, 400) }
  }

  const { resolvedPath } = result

  try {
    const statResult = await fsStat(resolvedPath)
    const mimeType = lookupMimeType(resolvedPath)
    return {
      baseDir,
      requestPath,
      resolvedPath,
      responseMimeType: normalizeResponseMimeType(mimeType),
      stat: statResult,
      mimeType,
    }
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return { response: errorResponse(c, "NotFound", notFoundMessage, 400) }
    }
    throw err
  }
}

export async function readFileResponse(
  resolvedPath: string,
  headers: Record<string, string>,
): Promise<Response> {
  const contentBuffer = await readFile(resolvedPath)
  return new Response(toArrayBuffer(contentBuffer), { headers })
}

export async function readBinaryFileResponse(
  resolvedPath: string,
  responseMimeType: string,
) {
  return readFileResponse(resolvedPath, { "Content-Type": responseMimeType })
}

function notAFileResponse(c: Context<AppBindings>) {
  return errorResponse(c, "NotAFile", "Not a file", 400)
}

function notADirectoryResponse(c: Context<AppBindings>) {
  return errorResponse(c, "NotADirectory", "Not a directory", 400)
}
