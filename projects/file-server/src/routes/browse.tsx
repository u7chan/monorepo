import { Hono } from "hono"
import { FileList } from "../components/FileList"
import type { AppBindings } from "../types"
import { resolveBrowseView } from "../utils/browseContext"
import {
  errorResponse,
  getRequestPath,
  getUploadDir,
  renderWithShell,
} from "../utils/requestUtils"

const browseRoutes = new Hono<AppBindings>()

browseRoutes.get("/", async (c) => {
  const baseDir = getUploadDir(c)
  const requestPath = getRequestPath(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  const resolved = await resolveBrowseView(baseDir, user, requestPath)

  if (resolved.kind === "forbidden") {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }
  if (resolved.kind === "notFound") {
    return errorResponse(c, "NotFound", "File or directory does not exist", 400)
  }
  if (resolved.kind === "file") {
    return c.redirect(`/file?path=${encodeURIComponent(requestPath)}`)
  }

  return renderWithShell(c, <FileList view={resolved.view} />)
})

browseRoutes.get("/browse", async (c) => {
  const baseDir = getUploadDir(c)
  const requestPath = getRequestPath(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  const resolved = await resolveBrowseView(baseDir, user, requestPath)

  if (resolved.kind === "forbidden") {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }
  if (resolved.kind === "notFound") {
    return errorResponse(c, "NotFound", "Directory does not exist", 400)
  }
  if (resolved.kind === "file") {
    return errorResponse(c, "NotADirectory", "Not a directory", 400)
  }

  return c.html(<FileList view={resolved.view} />)
})

export default browseRoutes
