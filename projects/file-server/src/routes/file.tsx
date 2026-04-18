import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import { FileViewer } from "../components/file-viewer"
import type { AppBindings } from "../types"
import { ensureUploadDirExists } from "../utils/fileListing"
import {
  archiveFileName,
  createDirectoryArchive,
  isPreviewableBinary,
  isTextMime,
  notADirectoryResponse,
  notAFileResponse,
  readBinaryFileResponse,
  resolveRequestedFile,
  toArrayBuffer,
} from "../utils/fileRouteUtils"
import {
  errorResponse,
  isHtmxRequest,
  renderWithShell,
} from "../utils/requestUtils"

const fileRoutes = new Hono<AppBindings>()

// /: ファイル閲覧部分HTML（htmx用）
fileRoutes.get("/", async (c) => {
  const resolved = await resolveRequestedFile(c, "File does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

  await ensureUploadDirExists(resolved.uploadDir)
  if (!resolved.stat.isFile()) {
    return notAFileResponse(c)
  }

  const isText = isTextMime(resolved.mimeType)
  const forceTextView = c.req.query("view") === "text"
  const isHtmx = isHtmxRequest(c)

  // htmxリクエストでない場合（リロード時）は親ディレクトリにリダイレクト
  if (!isHtmx) {
    const parentDir = path.dirname(resolved.requestPath)
    const redirectPath =
      parentDir === "." ? "/" : `/?path=${encodeURIComponent(parentDir)}`
    return c.redirect(redirectPath)
  }

  if (isText || forceTextView) {
    const content = await readFile(resolved.resolvedPath, "utf-8")
    const isEditing = !forceTextView && c.req.query("edit") === "true"
    return renderWithShell(
      c,
      <FileViewer
        content={content}
        fileName={path.basename(resolved.resolvedPath)}
        path={resolved.requestPath}
        isEditing={isEditing}
        allowEdit={!forceTextView}
      />,
    )
  }

  if (isPreviewableBinary(resolved.mimeType)) {
    return renderWithShell(
      c,
      <FileViewer
        mimeType={resolved.mimeType}
        fileName={path.basename(resolved.resolvedPath)}
        path={resolved.requestPath}
      />,
    )
  }

  if (isHtmx) {
    return c.html(
      <FileViewer
        fileName={path.basename(resolved.resolvedPath)}
        path={resolved.requestPath}
      />,
    )
  }

  const contentBuffer = await readFile(resolved.resolvedPath)
  const headers: Record<string, string> = {
    "Content-Type": resolved.mimeType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolved.resolvedPath))}`,
  }
  return new Response(toArrayBuffer(contentBuffer), { headers })
})

// /raw: バイナリファイルの生データ（画像/動画/PDF用）
fileRoutes.get("/raw", async (c) => {
  const resolved = await resolveRequestedFile(c, "File does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

  await ensureUploadDirExists(resolved.uploadDir)
  if (!resolved.stat.isFile()) {
    return notAFileResponse(c)
  }

  return readBinaryFileResponse(resolved.resolvedPath, resolved.mimeType)
})

// /archive: ディレクトリ配下のZipダウンロード
fileRoutes.get("/archive", async (c) => {
  const resolved = await resolveRequestedFile(c, "Directory does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

  await ensureUploadDirExists(resolved.uploadDir)
  if (!resolved.stat.isDirectory()) {
    return notADirectoryResponse(c)
  }

  const { body, error } = await createDirectoryArchive(resolved.resolvedPath)
  if (error) {
    return errorResponse(c, "ArchiveError", error, 500)
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveFileName(resolved.requestPath))}`,
    },
  })
})

export default fileRoutes
