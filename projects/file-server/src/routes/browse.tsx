import * as path from "node:path"
import { Hono } from "hono"
import { FileList } from "../components/FileList"
import type { AppBindings } from "../types"
import { getFileList } from "../utils/fileListing"
import {
  ensureValidPath,
  errorResponse,
  getRequestPath,
  getUploadDir,
  renderWithShell,
  statOrNotFound,
} from "../utils/requestUtils"

const browseRoutes = new Hono<AppBindings>()

// ルート: フルHTMLシェルまたは部分HTMLを返す
browseRoutes.get("/", async (c) => {
  const uploadDir = getUploadDir(c)
  const requestPath = getRequestPath(c)

  const invalidResponse = ensureValidPath(c, requestPath)
  if (invalidResponse) {
    return invalidResponse
  }

  const resolvedDir = path.join(uploadDir, requestPath)
  const statOrResponse = await statOrNotFound(
    c,
    resolvedDir,
    "NotFound",
    "File or directory does not exist",
  )
  if (statOrResponse instanceof Response) {
    return statOrResponse
  }

  if (statOrResponse.isFile()) {
    return c.redirect(`/file?path=${encodeURIComponent(requestPath)}`)
  }

  const files = await getFileList(uploadDir, requestPath)
  return renderWithShell(
    c,
    <FileList files={files} requestPath={requestPath} />,
  )
})

// /browse: 一覧部分HTML（htmx用）
browseRoutes.get("/browse", async (c) => {
  const uploadDir = getUploadDir(c)
  const requestPath = getRequestPath(c)

  const invalidResponse = ensureValidPath(c, requestPath)
  if (invalidResponse) {
    return invalidResponse
  }

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

  const files = await getFileList(uploadDir, requestPath)
  return c.html(<FileList files={files} requestPath={requestPath} />)
})

export default browseRoutes
