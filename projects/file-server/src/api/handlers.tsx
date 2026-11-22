import {
  stat as fsStat,
  mkdir,
  writeFile,
} from "node:fs/promises"
import * as path from "node:path"
import type { Context } from "hono"
import z from "zod"
import type { AppBindings } from "../types"
import { renderFileListResponse } from "../utils/apiHelpers"
import { getFileList } from "../utils/fileListing"
import { readTextPreview } from "../utils/filePreviewLimits"
import { buildFullTextUrl, isActiveContent } from "../utils/fileRouteUtils"
import { resolveUploadPath } from "../utils/fileUtils"
import { lookupMimeType } from "../utils/mimeType"
import { isNodeErrorCode } from "../utils/nodeError"
import { isPathTraversal } from "../utils/pathTraversal"
import {
  errorResponse,
  forbiddenResponse,
  getUploadDir,
  getUser,
  invalidPathResponse,
  isHtmxRequest,
} from "../utils/requestUtils"
import {
  requireWritePermission,
  resolveVirtualPath,
} from "../utils/virtualPath"

const BASE_PATH_REGEX = /^\/api\/?/
const uploadRequestSchema = z.object({
  files: z
    .preprocess(
      (val) => (Array.isArray(val) ? val : val ? [val] : []),
      z.array(z.instanceof(File)).max(10),
    )
    .optional()
    .transform((files) => files ?? []),
  path: z.string().optional(),
})

export async function listFilesHandler(c: Context<AppBindings>) {
  const baseDir = getUploadDir(c)
  const user = getUser(c)
  const subPath = c.req.path.replace(BASE_PATH_REGEX, "")

  if (isPathTraversal(subPath)) {
    return invalidPathResponse(c)
  }

  const result = resolveVirtualPath(baseDir, user, subPath)

  if (result.kind === "forbidden") {
    return forbiddenResponse(c)
  }
  if (result.kind === "notFound") {
    return errorResponse(c, "DirNotFound", "Directory does not exist", 400)
  }
  if (result.kind === "synthetic") {
    return c.json({
      files: result.entries.map(({ mtime, ...file }) => file),
    })
  }

  try {
    const files = await getFileList(result.resolvedPath)
    return c.json({
      files: files.map(({ mtime, ...file }) => file),
    })
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(c, "DirNotFound", "Directory does not exist", 400)
    }
    throw err
  }
}

export async function uploadFileHandler(c: Context<AppBindings>) {
  const parsedBody = await c.req.parseBody({ all: true })
  const validatedData = uploadRequestSchema.safeParse(parsedBody)
  if (!validatedData.success) {
    return errorResponse(
      c,
      "ZodError",
      validatedData.error.issues[0]?.message ?? validatedData.error.message,
      400,
    )
  }

  const { files, path: filePathParam } = validatedData.data
  const baseDir = getUploadDir(c)
  const user = getUser(c)

  const virtualPath = filePathParam || "public"

  if (!requireWritePermission(user, virtualPath)) {
    return forbiddenResponse(c)
  }

  const results = {
    success: [] as string[],
    failed: [] as { name: string; reason: string }[],
  }

  for (const file of files) {
    try {
      const relativePath = await resolveUploadPath(
        baseDir,
        virtualPath,
        file.name,
      )
      if (isPathTraversal(relativePath)) {
        results.failed.push({
          name: file.name,
          reason: "Invalid path",
        })
        continue
      }

      const savePath = path.join(baseDir, relativePath)
      await mkdir(path.dirname(savePath), { recursive: true })
      const buffer = await file.arrayBuffer()

      await writeFile(savePath, Buffer.from(buffer))
      results.success.push(file.name)
    } catch (err) {
      results.failed.push({
        name: file.name,
        reason: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }

  if (isHtmxRequest(c)) {
    return renderFileListResponse(c, baseDir, virtualPath)
  }

  return c.json({
    success: results.failed.length === 0,
    uploaded: results.success,
    failed: results.failed,
  })
}

export async function updateFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    content: string
  }
  const { path: filePathParam, content } = validatedData
  const baseDir = getUploadDir(c)
  const user = getUser(c)

  if (isPathTraversal(filePathParam)) {
    return invalidPathResponse(c)
  }

  if (!requireWritePermission(user, filePathParam)) {
    return forbiddenResponse(c)
  }

  const targetPath = path.join(baseDir, filePathParam)
  try {
    const stat = await fsStat(targetPath)
    if (!stat.isFile()) {
      return errorResponse(c, "NotAFile", "Path is not a file", 400)
    }
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(c, "FileNotFound", "File does not exist", 400)
    }
    throw err
  }

  await writeFile(targetPath, content, "utf-8")

  if (isHtmxRequest(c)) {
    const { FileViewer } = await import("../components/file-viewer")
    const preview = await readTextPreview(targetPath)
    const mimeType = lookupMimeType(targetPath)
    return c.html(
      <FileViewer
        content={preview.content}
        truncatedFileSize={preview.truncated ? preview.size : undefined}
        fullTextUrl={
          preview.truncated && !isActiveContent(targetPath, mimeType)
            ? buildFullTextUrl(filePathParam)
            : undefined
        }
        fileName={path.basename(targetPath)}
        path={filePathParam}
        isEditing={false}
      />,
    )
  }

  return c.json({ success: true })
}
