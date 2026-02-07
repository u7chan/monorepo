import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import * as mime from "mime-types"
import { FileViewer } from "../components/file-viewer"
import type { AppBindings } from "../types"
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

const toArrayBuffer = (contentBuffer: Buffer): ArrayBuffer =>
  contentBuffer.buffer.slice(
    contentBuffer.byteOffset,
    contentBuffer.byteOffset + contentBuffer.byteLength,
  ) as ArrayBuffer

// /file: ファイル閲覧部分HTML（htmx用）
fileRoutes.get("/file", async (c) => {
  const uploadDir = getUploadDir(c)
  const requestPath = getRequestPath(c)

  const invalidResponse = ensureValidPath(c, requestPath)
  if (invalidResponse) {
    return invalidResponse
  }

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
  const isHtmx = isHtmxRequest(c)

  if (isText) {
    const content = await readFile(resolvedFile, "utf-8")
    return renderWithShell(
      c,
      <FileViewer
        content={content}
        fileName={path.basename(resolvedFile)}
        path={requestPath}
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

// /file/raw: バイナリファイルの生データ（画像/動画/PDF用）
fileRoutes.get("/file/raw", async (c) => {
  const uploadDir = getUploadDir(c)
  const requestPath = getRequestPath(c)

  const invalidResponse = ensureValidPath(c, requestPath)
  if (invalidResponse) {
    return invalidResponse
  }

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

export default fileRoutes
