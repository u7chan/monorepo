import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import { FileViewer } from "../components/file-viewer"
import type { AppBindings } from "../types"
import { toBrowseLocation } from "../utils/auth"
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

fileRoutes.get("/", async (c) => {
  const resolved = await resolveRequestedFile(c, "File does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

  if (!resolved.stat.isFile()) {
    return notAFileResponse(c)
  }

  const isText = isTextMime(resolved.mimeType)
  const forceTextView = c.req.query("view") === "text"
  const isHtmx = isHtmxRequest(c)

  if (!isHtmx) {
    const parentDir = toBrowseLocation(
      c.get("user") ?? { type: "anonymous" as const },
      path.dirname(resolved.requestPath),
    )
    const redirectPath =
      parentDir === "." || parentDir === ""
        ? "/"
        : `/?path=${encodeURIComponent(parentDir)}`
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

fileRoutes.get("/raw", async (c) => {
  const resolved = await resolveRequestedFile(c, "File does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

  if (!resolved.stat.isFile()) {
    return notAFileResponse(c)
  }

  return readBinaryFileResponse(resolved.resolvedPath, resolved.mimeType)
})

fileRoutes.get("/archive", async (c) => {
  const resolved = await resolveRequestedFile(c, "Directory does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

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
