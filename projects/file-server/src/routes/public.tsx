import * as path from "node:path"
import { Hono } from "hono"
import * as mime from "mime-types"
import type { AppBindings } from "../types"
import { isPathTraversal } from "../utils/pathTraversal"
import { errorResponse, getUploadDir } from "../utils/requestUtils"

const publicRoutes = new Hono<AppBindings>()

const ACTIVE_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
])

const ACTIVE_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".svg"])

function isActiveContent(filePath: string, mimeType: string): boolean {
  if (ACTIVE_MIME_TYPES.has(mimeType)) {
    return true
  }
  const ext = path.extname(filePath).toLowerCase()
  return ACTIVE_EXTENSIONS.has(ext)
}

publicRoutes.get("/*", async (c) => {
  const baseDir = getUploadDir(c)

  const rawPath = c.req.path.replace(/^\/public\/?/, "")

  if (!rawPath) {
    return errorResponse(c, "NotFound", "File not found", 404)
  }

  if (isPathTraversal(rawPath)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  const resolvedPath = path.join(baseDir, "public", rawPath)
  const mimeType = mime.lookup(resolvedPath) || "application/octet-stream"

  if (isActiveContent(resolvedPath, mimeType)) {
    return errorResponse(
      c,
      "ActiveContentNotAllowed",
      "HTML/SVG delivery is tracked in a follow-up issue.",
      403,
    )
  }

  try {
    const { stat, readFile } = await import("node:fs/promises")
    const fileStat = await stat(resolvedPath)
    if (!fileStat.isFile()) {
      return errorResponse(c, "NotFound", "File not found", 404)
    }

    const content = await readFile(resolvedPath)
    return new Response(content, {
      headers: { "Content-Type": mimeType },
    })
  } catch (err: unknown) {
    const isEnoent =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    if (isEnoent) {
      return errorResponse(c, "NotFound", "File not found", 404)
    }
    throw err
  }
})

export default publicRoutes
