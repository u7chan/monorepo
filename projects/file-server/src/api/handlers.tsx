import {
  stat as fsStat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import * as path from "node:path"
import type { Context } from "hono"
import type { AppBindings } from "../types"
import {
  alreadyExistsResponse,
  renderFileListResponse,
} from "../utils/apiHelpers"
import { getFileList } from "../utils/fileListing"
import { normalizeRelativePath, resolveUploadPath } from "../utils/fileUtils"
import {
  isPublicHtmlFile,
  isPublicScope,
  validatePublicHtml,
} from "../utils/htmlValidation"
import { isPathTraversal } from "../utils/pathTraversal"
import {
  errorResponse,
  getUploadDir,
  isHtmxRequest,
  isNodeErrorCode,
} from "../utils/requestUtils"
import {
  requireWritePermission,
  resolveVirtualPath,
} from "../utils/virtualPath"

const BASE_PATH_REGEX = /^\/api\/?/

function isInvalidNodeName(name: string): boolean {
  return (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  )
}

export async function listFilesHandler(c: Context<AppBindings>) {
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }
  const subPath = c.req.path.replace(BASE_PATH_REGEX, "")

  if (isPathTraversal(subPath)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  const result = resolveVirtualPath(baseDir, user, subPath)

  if (result.kind === "forbidden") {
    return errorResponse(c, "Forbidden", "Access denied", 403)
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
  const validatedData = c.req.valid("form" as never) as {
    files: File[]
    path?: string
  }
  const { files, path: filePathParam } = validatedData
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  const virtualPath = filePathParam || "public"

  if (!requireWritePermission(user, virtualPath)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
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

      if (isPublicScope(relativePath) && isPublicHtmlFile(relativePath)) {
        if (user.type === "authenticated" && user.role !== "admin") {
          results.failed.push({
            name: file.name,
            reason: "Only admin can upload HTML/SVG files to public scope",
          })
          continue
        }
        const text = Buffer.from(buffer).toString("utf-8")
        const validation = validatePublicHtml(text)
        if (!validation.ok) {
          results.failed.push({ name: file.name, reason: validation.reason })
          continue
        }
      }

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

export async function deleteFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
  }
  const { path: filePathParam } = validatedData
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  if (isPathTraversal(filePathParam)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  if (!requireWritePermission(user, filePathParam)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  const targetPath = path.join(baseDir, filePathParam)
  let redirectVirtualPath = ""
  try {
    const stat = await fsStat(targetPath)
    if (stat.isDirectory()) {
      const parentOfDir = path.dirname(targetPath)
      redirectVirtualPath = path.relative(baseDir, parentOfDir)
      await rm(targetPath, { recursive: true, force: true })
    } else {
      const dirOfFile = path.dirname(targetPath)
      redirectVirtualPath = path.relative(baseDir, dirOfFile)
      await unlink(targetPath)
    }
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(
        c,
        "FileNotFound",
        "File or directory does not exist",
        400,
      )
    }
    throw err
  }

  redirectVirtualPath = normalizeRelativePath(redirectVirtualPath)

  return renderFileListResponse(c, baseDir, redirectVirtualPath, {
    encodeRedirectPath: false,
  })
}

export async function mkdirHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    folder: string
  }
  const { path: dirPathParam, folder } = validatedData
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  if (isPathTraversal(dirPathParam) || isInvalidNodeName(folder)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  if (!requireWritePermission(user, dirPathParam)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  const targetDir = path.join(baseDir, dirPathParam)
  try {
    await mkdir(path.join(targetDir, folder), { recursive: false })
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "EEXIST")) {
      return alreadyExistsResponse(c, folder)
    }
    throw err
  }

  return renderFileListResponse(c, baseDir, dirPathParam || "")
}

export async function createFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    file: string
  }
  const { path: dirPathParam, file } = validatedData
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  if (isPathTraversal(dirPathParam) || isInvalidNodeName(file)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  if (!requireWritePermission(user, dirPathParam)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  const targetDir = path.join(baseDir, dirPathParam)

  try {
    await writeFile(path.join(targetDir, file), "", { flag: "wx" })
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "EEXIST")) {
      return alreadyExistsResponse(c, file)
    }
    throw err
  }

  return renderFileListResponse(c, baseDir, dirPathParam || "")
}

export async function renameHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    name: string
  }
  const { path: currentPathParam, name } = validatedData
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  if (isPathTraversal(currentPathParam) || isInvalidNodeName(name)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  if (!requireWritePermission(user, currentPathParam)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  const parentPath = path.dirname(currentPathParam)
  const normalizedParentPath = normalizeRelativePath(parentPath)
  const currentName = path.basename(currentPathParam)

  if (currentName === name) {
    return renderFileListResponse(c, baseDir, normalizedParentPath)
  }

  const sourcePath = path.join(baseDir, currentPathParam)
  const destinationRelativePath = normalizedParentPath
    ? path.join(normalizedParentPath, name)
    : name
  const destinationPath = path.join(baseDir, destinationRelativePath)

  try {
    await fsStat(sourcePath)
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(
        c,
        "FileNotFound",
        "File or directory does not exist",
        400,
      )
    }
    throw err
  }

  try {
    await fsStat(destinationPath)
    return alreadyExistsResponse(c, name)
  } catch (err: unknown) {
    if (!isNodeErrorCode(err, "ENOENT")) {
      throw err
    }
  }

  if (
    isPublicScope(destinationRelativePath) &&
    isPublicHtmlFile(destinationRelativePath)
  ) {
    if (user.type === "authenticated" && user.role !== "admin") {
      return errorResponse(
        c,
        "Forbidden",
        "Only admin can rename files to HTML/SVG in public scope",
        403,
      )
    }
    const sourceContent = await readFile(sourcePath, "utf-8")
    const validation = validatePublicHtml(sourceContent)
    if (!validation.ok) {
      return errorResponse(c, "ValidationError", validation.reason, 400)
    }
  }

  await rename(sourcePath, destinationPath)

  return renderFileListResponse(c, baseDir, normalizedParentPath)
}

export async function updateFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    content: string
  }
  const { path: filePathParam, content } = validatedData
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  if (isPathTraversal(filePathParam)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  if (!requireWritePermission(user, filePathParam)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
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

  if (isPublicScope(filePathParam) && isPublicHtmlFile(filePathParam)) {
    if (user.type === "authenticated" && user.role !== "admin") {
      return errorResponse(
        c,
        "Forbidden",
        "Only admin can update HTML/SVG files in public scope",
        403,
      )
    }
    const validation = validatePublicHtml(content)
    if (!validation.ok) {
      return errorResponse(c, "ValidationError", validation.reason, 400)
    }
  }

  await writeFile(targetPath, content, "utf-8")

  if (isHtmxRequest(c)) {
    const { FileViewer } = await import("../components/file-viewer")
    const updatedContent = await readFile(targetPath, "utf-8")
    return c.html(
      <FileViewer
        content={updatedContent}
        fileName={path.basename(targetPath)}
        path={filePathParam}
        isEditing={false}
      />,
    )
  }

  return c.json({ success: true })
}
