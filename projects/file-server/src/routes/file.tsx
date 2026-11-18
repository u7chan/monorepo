import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import { FileViewer } from "../components/file-viewer"
import type { AppBindings } from "../types"
import { toBrowseLocation } from "../utils/auth"
import {
  ACTIVE_CONTENT_PREVIEW_CSP,
  archiveFileName,
  createDirectoryArchive,
  encodeVirtualPath,
  isActiveContent,
  isPreviewableBinary,
  isTextMime,
  notADirectoryResponse,
  notAFileResponse,
  readBinaryFileResponse,
  resolveRequestedFile,
  resolveRequestedFileAtPath,
  toArrayBuffer,
} from "../utils/fileRouteUtils"
import {
  errorResponse,
  isHtmxRequest,
  renderWithShell,
} from "../utils/requestUtils"

const fileRoutes = new Hono<AppBindings>()

function decodePreviewPath(encodedPath: string): string | null {
  try {
    return encodedPath
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
      .join("/")
  } catch {
    return null
  }
}

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

  const isInPublicScope = resolved.requestPath.startsWith("public/")
  const isHtmlOrSvg = isActiveContent(resolved.resolvedPath, resolved.mimeType)
  const encodedRequestPath = encodeVirtualPath(resolved.requestPath)
  const publicUrl =
    isInPublicScope && isHtmlOrSvg ? `/${encodedRequestPath}` : undefined
  const previewUrl =
    !isInPublicScope && isHtmlOrSvg
      ? `/file/preview/${encodedRequestPath}`
      : undefined

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
        publicUrl={publicUrl}
        previewUrl={previewUrl}
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
    "Content-Type": resolved.responseMimeType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolved.resolvedPath))}`,
  }
  return new Response(toArrayBuffer(contentBuffer), { headers })
})

fileRoutes.get("/preview/*", async (c) => {
  const encodedPath = c.req.path.replace(/^\/file\/preview\/?/, "")
  const requestPath = decodePreviewPath(encodedPath)
  if (!requestPath) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  const resolved = await resolveRequestedFileAtPath(
    c,
    requestPath,
    "File does not exist",
  )
  if ("response" in resolved) {
    return resolved.response
  }

  if (!resolved.stat.isFile()) {
    return notAFileResponse(c)
  }

  const contentBuffer = await readFile(resolved.resolvedPath)
  const headers: Record<string, string> = {
    "Content-Type": resolved.responseMimeType,
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  }

  if (isActiveContent(resolved.resolvedPath, resolved.mimeType)) {
    headers["Content-Security-Policy"] = ACTIVE_CONTENT_PREVIEW_CSP
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

  if (isActiveContent(resolved.resolvedPath, resolved.mimeType)) {
    return errorResponse(
      c,
      "ActiveContentNotAllowed",
      "Active content cannot be served via /file/raw",
      403,
    )
  }

  return readBinaryFileResponse(
    resolved.resolvedPath,
    resolved.responseMimeType,
  )
})

fileRoutes.get("/download", async (c) => {
  const resolved = await resolveRequestedFile(c, "File does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

  if (!resolved.stat.isFile()) {
    return notAFileResponse(c)
  }

  const contentBuffer = await readFile(resolved.resolvedPath)
  return new Response(toArrayBuffer(contentBuffer), {
    headers: {
      "Content-Type": resolved.responseMimeType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolved.resolvedPath))}`,
    },
  })
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
