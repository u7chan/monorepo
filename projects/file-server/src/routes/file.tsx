import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import * as mime from "mime-types"
import { FileViewer } from "../components/file-viewer"
import type { AppBindings } from "../types"
import { ensureUploadDirExists } from "../utils/fileListing"
import {
  ensureValidPath,
  errorResponse,
  getRequestPath,
  getUploadDir,
  isHtmxRequest,
  renderWithShell,
  statOrNotFound,
} from "../utils/requestUtils"

const fileRoutes = new Hono<AppBindings>()

const isTextMime = (mimeType: string) =>
  /^text\//.test(mimeType) || /json$|javascript$|xml$/.test(mimeType)

const isPreviewableBinary = (mimeType: string) =>
  mimeType.startsWith("image/") ||
  mimeType.startsWith("video/") ||
  mimeType === "application/pdf"

const EMPTY_ZIP_ARCHIVE = new Uint8Array([
  0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])

const toArrayBuffer = (contentBuffer: Buffer): ArrayBuffer =>
  contentBuffer.buffer.slice(
    contentBuffer.byteOffset,
    contentBuffer.byteOffset + contentBuffer.byteLength,
  ) as ArrayBuffer

const archiveFileName = (requestPath: string) =>
  requestPath ? `${path.basename(requestPath)}.zip` : "root.zip"

const isZipCommandMissing = (message: string) =>
  message.includes('Executable not found in $PATH: "zip"')

const archiveErrorMessage = (error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Failed to start zip command"

  if (isZipCommandMissing(message)) {
    return "Zip download is unavailable because the server does not have the zip command installed"
  }

  return message
}

async function createDirectoryArchive(
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

// /: ファイル閲覧部分HTML（htmx用）
fileRoutes.get("/", async (c) => {
  const uploadDir = getUploadDir(c)
  const requestPath = getRequestPath(c)

  const invalidResponse = ensureValidPath(c, requestPath)
  if (invalidResponse) {
    return invalidResponse
  }

  await ensureUploadDirExists(uploadDir)
  const resolvedFile = path.join(uploadDir, requestPath)
  const statOrResponse = await statOrNotFound(
    c,
    resolvedFile,
    "NotFound",
    "File does not exist",
  )
  if (statOrResponse instanceof Response) {
    return statOrResponse
  }

  if (!statOrResponse.isFile()) {
    return errorResponse(c, "NotAFile", "Not a file", 400)
  }

  const mimeType = mime.lookup(resolvedFile) || "application/octet-stream"
  const isText = isTextMime(mimeType)
  const forceTextView = c.req.query("view") === "text"
  const isHtmx = isHtmxRequest(c)

  // htmxリクエストでない場合（リロード時）は親ディレクトリにリダイレクト
  if (!isHtmx) {
    const parentDir = path.dirname(requestPath)
    const redirectPath =
      parentDir === "." ? "/" : `/?path=${encodeURIComponent(parentDir)}`
    return c.redirect(redirectPath)
  }

  if (isText || forceTextView) {
    const content = await readFile(resolvedFile, "utf-8")
    const isEditing = !forceTextView && c.req.query("edit") === "true"
    return renderWithShell(
      c,
      <FileViewer
        content={content}
        fileName={path.basename(resolvedFile)}
        path={requestPath}
        isEditing={isEditing}
        allowEdit={!forceTextView}
      />,
    )
  }

  if (isPreviewableBinary(mimeType)) {
    return renderWithShell(
      c,
      <FileViewer
        mimeType={mimeType}
        fileName={path.basename(resolvedFile)}
        path={requestPath}
      />,
    )
  }

  if (isHtmx) {
    return c.html(
      <FileViewer fileName={path.basename(resolvedFile)} path={requestPath} />,
    )
  }

  const contentBuffer = await readFile(resolvedFile)
  const headers: Record<string, string> = {
    "Content-Type": mimeType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolvedFile))}`,
  }
  return new Response(toArrayBuffer(contentBuffer), { headers })
})

// /raw: バイナリファイルの生データ（画像/動画/PDF用）
fileRoutes.get("/raw", async (c) => {
  const uploadDir = getUploadDir(c)
  const requestPath = getRequestPath(c)

  const invalidResponse = ensureValidPath(c, requestPath)
  if (invalidResponse) {
    return invalidResponse
  }

  await ensureUploadDirExists(uploadDir)
  const resolvedFile = path.join(uploadDir, requestPath)
  const statOrResponse = await statOrNotFound(
    c,
    resolvedFile,
    "NotFound",
    "File does not exist",
  )
  if (statOrResponse instanceof Response) {
    return statOrResponse
  }

  if (!statOrResponse.isFile()) {
    return errorResponse(c, "NotAFile", "Not a file", 400)
  }

  const mimeType = mime.lookup(resolvedFile) || "application/octet-stream"
  const contentBuffer = await readFile(resolvedFile)
  const headers: Record<string, string> = { "Content-Type": mimeType }

  return new Response(toArrayBuffer(contentBuffer), { headers })
})

// /archive: ディレクトリ配下のZipダウンロード
fileRoutes.get("/archive", async (c) => {
  const uploadDir = getUploadDir(c)
  const requestPath = getRequestPath(c)

  const invalidResponse = ensureValidPath(c, requestPath)
  if (invalidResponse) {
    return invalidResponse
  }

  await ensureUploadDirExists(uploadDir)
  const resolvedDir = path.join(uploadDir, requestPath)
  const statOrResponse = await statOrNotFound(
    c,
    resolvedDir,
    "NotFound",
    "Directory does not exist",
  )
  if (statOrResponse instanceof Response) {
    return statOrResponse
  }

  if (!statOrResponse.isDirectory()) {
    return errorResponse(c, "NotADirectory", "Not a directory", 400)
  }

  const { body, error } = await createDirectoryArchive(resolvedDir)
  if (error) {
    return errorResponse(c, "ArchiveError", error, 500)
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveFileName(requestPath))}`,
    },
  })
})

export default fileRoutes
