import * as path from "node:path"
import { Hono } from "hono"
import type { AppBindings } from "../types"
import { resolveResponseMimeType } from "../utils/mimeType"
import { isPathTraversal } from "../utils/pathTraversal"
import { errorResponse, getUploadDir } from "../utils/requestUtils"

const publicRoutes = new Hono<AppBindings>()

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
  const responseMimeType = resolveResponseMimeType(resolvedPath)

  try {
    const { stat, readFile } = await import("node:fs/promises")
    const fileStat = await stat(resolvedPath)
    if (!fileStat.isFile()) {
      return errorResponse(c, "NotFound", "File not found", 404)
    }

    const content = await readFile(resolvedPath)
    return new Response(content, {
      headers: { "Content-Type": responseMimeType },
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
