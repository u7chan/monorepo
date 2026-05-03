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
import { MovePickerModal } from "../components/file-list/MovePickerModal"
import type { AppBindings } from "../types"
import {
  alreadyExistsResponse,
  renderFileListResponse,
} from "../utils/apiHelpers"
import { getFileList } from "../utils/fileListing"
import { normalizeRelativePath, resolveUploadPath } from "../utils/fileUtils"
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
import z from "zod"

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

  await rename(sourcePath, destinationPath)

  return renderFileListResponse(c, baseDir, normalizedParentPath)
}

function getTopScope(virtualPath: string): string | null {
  const parts = virtualPath.split("/").filter(Boolean)
  return parts[0] ?? null
}

function containsParentSegment(p: string): boolean {
  return p
    .replaceAll("\\", "/")
    .split("/")
    .some((seg) => seg === "..")
}

function resolveMovePickerRoot(
  user:
    | { type: "anonymous" }
    | { type: "authenticated"; username: string; role: "admin" | "user" },
  scope: "public" | "private",
): string {
  if (scope === "public") {
    return "public"
  }
  if (user.type === "authenticated" && user.role === "user") {
    return `private/${user.username}`
  }
  return "private"
}

export async function moveHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    destination: string
  }
  const { path: sourcePathParam, destination: destinationParam } = validatedData
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  if (
    isPathTraversal(sourcePathParam) ||
    isPathTraversal(destinationParam) ||
    containsParentSegment(sourcePathParam) ||
    containsParentSegment(destinationParam)
  ) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  const normalizedSource = normalizeRelativePath(sourcePathParam)
  const normalizedDestination = normalizeRelativePath(destinationParam)

  if (!normalizedSource) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  if (!requireWritePermission(user, normalizedSource)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }
  if (!requireWritePermission(user, normalizedDestination)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  const sourceScope = getTopScope(normalizedSource)
  const destinationScope = getTopScope(normalizedDestination)
  if (sourceScope !== destinationScope) {
    return errorResponse(
      c,
      "CrossScope",
      "Cannot move across public and private scopes",
      400,
    )
  }

  const sourcePath = path.join(baseDir, normalizedSource)
  let sourceStat: Awaited<ReturnType<typeof fsStat>>
  try {
    sourceStat = await fsStat(sourcePath)
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

  const destinationDirPath = path.join(baseDir, normalizedDestination)
  try {
    const destStat = await fsStat(destinationDirPath)
    if (!destStat.isDirectory()) {
      return errorResponse(
        c,
        "DestNotDirectory",
        "Destination is not a directory",
        400,
      )
    }
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(
        c,
        "DestNotFound",
        "Destination directory does not exist",
        400,
      )
    }
    throw err
  }

  if (sourceStat.isDirectory()) {
    const resolvedSource = path.resolve(sourcePath)
    const resolvedDest = path.resolve(destinationDirPath)
    if (
      resolvedDest === resolvedSource ||
      resolvedDest.startsWith(`${resolvedSource}${path.sep}`)
    ) {
      return errorResponse(
        c,
        "InvalidDestination",
        "Cannot move a directory into itself",
        400,
      )
    }
  }

  const basename = path.basename(normalizedSource)
  const finalDestinationRelative = normalizedDestination
    ? `${normalizedDestination}/${basename}`
    : basename
  const finalDestinationPath = path.join(baseDir, finalDestinationRelative)

  const sourceParent = normalizeRelativePath(path.dirname(normalizedSource))

  if (path.resolve(sourcePath) === path.resolve(finalDestinationPath)) {
    return renderFileListResponse(c, baseDir, sourceParent)
  }

  try {
    await fsStat(finalDestinationPath)
    return alreadyExistsResponse(c, basename)
  } catch (err: unknown) {
    if (!isNodeErrorCode(err, "ENOENT")) {
      throw err
    }
  }

  await rename(sourcePath, finalDestinationPath)

  return renderFileListResponse(c, baseDir, sourceParent)
}

export async function movePickerHandler(c: Context<AppBindings>) {
  const sourceParam = c.req.query("source") ?? ""
  const destParam = c.req.query("dest")
  const baseDir = getUploadDir(c)
  const user = c.get("user") ?? { type: "anonymous" as const }

  if (
    !sourceParam ||
    isPathTraversal(sourceParam) ||
    containsParentSegment(sourceParam)
  ) {
    return errorResponse(c, "PathError", "Invalid source", 400)
  }
  if (destParam !== undefined && containsParentSegment(destParam)) {
    return errorResponse(c, "PathError", "Invalid destination", 400)
  }

  const normalizedSource = normalizeRelativePath(sourceParam)
  if (!normalizedSource) {
    return errorResponse(c, "PathError", "Invalid source", 400)
  }

  if (!requireWritePermission(user, normalizedSource)) {
    return errorResponse(c, "Forbidden", "Access denied", 403)
  }

  const scope = getTopScope(normalizedSource)
  if (scope !== "public" && scope !== "private") {
    return errorResponse(c, "PathError", "Invalid source scope", 400)
  }

  const pickerRoot = resolveMovePickerRoot(user, scope)

  let currentDest: string
  if (destParam === undefined) {
    const sourceParent = normalizeRelativePath(path.dirname(normalizedSource))
    currentDest = sourceParent || pickerRoot
  } else {
    const normalized = normalizeRelativePath(destParam)
    currentDest = normalized || pickerRoot
  }

  if (isPathTraversal(currentDest)) {
    return errorResponse(c, "PathError", "Invalid destination", 400)
  }

  if (currentDest !== pickerRoot && !currentDest.startsWith(`${pickerRoot}/`)) {
    currentDest = pickerRoot
  }

  const resolved = resolveVirtualPath(baseDir, user, currentDest)
  if (resolved.kind !== "resolved") {
    return errorResponse(c, "PathError", "Cannot resolve destination", 400)
  }

  try {
    const entries = await getFileList(resolved.resolvedPath)
    const directories = entries
      .filter((entry) => entry.type === "dir")
      .map(({ mtime: _m, size: _s, ...rest }) => rest)
    return c.html(
      <MovePickerModal
        source={normalizedSource}
        sourceName={path.basename(normalizedSource)}
        currentDest={currentDest}
        pickerRoot={pickerRoot}
        directories={directories}
      />,
    )
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return errorResponse(c, "DestNotFound", "Destination does not exist", 400)
    }
    throw err
  }
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
