import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import { FileViewer } from "../components/file-viewer"
import { MarkdownPreviewPage } from "../components/markdown/MarkdownPreviewPage"
import type { AppBindings } from "../types"
import { toBrowseLocation } from "../utils/auth"
import {
  ACTIVE_CONTENT_PREVIEW_CSP,
  archiveFileName,
  createDirectoryArchive,
  encodeVirtualPath,
  isActiveContent,
  isMarkdownFile,
  isPreviewableBinary,
  isTextMime,
  MARKDOWN_PREVIEW_CSP,
  notADirectoryResponse,
  notAFileResponse,
  readBinaryFileResponse,
  resolveRequestedFile,
  resolveRequestedFileAtPath,
  toArrayBuffer,
} from "../utils/fileRouteUtils"
import {
  errorResponse,
  getUser,
  invalidPathResponse,
  isHtmxRequest,
  renderWithShell,
} from "../utils/requestUtils"

const fileRoutes = new Hono<AppBindings>()

function decodePreviewPath(encodedPath: string): string | null {
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

fileRoutes.get("/", async (c) => {
  const resolved = await resolveRequestedFile(c, "File does not exist")
  if ("response" in resolved) {
    return resolved.response
  }

  if (!resolved.stat.isFile()) {
    return notAFileResponse(c)
  }

  // Why check the extension too: `mime-types` returns application/octet-stream
  // for `.mdown` / `.mkdn`, and those files must still open as text (source,
  // edit, preview) because they are Markdown.
  const isMarkdown = isMarkdownFile(resolved.resolvedPath, resolved.mimeType)
  const isText = isTextMime(resolved.mimeType) || isMarkdown
  const forceTextView = c.req.query("view") === "text"
  const isHtmx = isHtmxRequest(c)

  if (!isHtmx) {
    const parentDir = toBrowseLocation(
      getUser(c),
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
  // Markdown は独自レンダラで描くので、public でもサンドボックス用の
  // `/public/*` ではなくプレビュールートを開く。
  const previewUrl =
    isMarkdown || (!isInPublicScope && isHtmlOrSvg)
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
    return invalidPathResponse(c)
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

  if (isMarkdownFile(resolved.resolvedPath, resolved.mimeType)) {
    const content = await readFile(resolved.resolvedPath, "utf-8")
    return c.html(
      <MarkdownPreviewPage
        fileName={path.basename(resolved.resolvedPath)}
        content={content}
      />,
      200,
      {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": MARKDOWN_PREVIEW_CSP,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    )
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
