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
import { ensureUploadDirExists, getFileList } from "../utils/fileListing"
import { isInvalidPath, resolveUploadPath } from "../utils/fileUtils"
import {
  alreadyExistsResponse,
  isNodeErrorCode,
  renderFileListResponse,
} from "../utils/apiHelpers"
import { errorResponse, getUploadDir, isHtmxRequest } from "../utils/requestUtils"

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
  const uploadDir = getUploadDir(c)
  const subPath = c.req.path.replace(BASE_PATH_REGEX, "")

  if (isInvalidPath(subPath)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  try {
    const files = await getFileList(uploadDir, subPath)
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
  const uploadDir = getUploadDir(c)

  const results = {
    success: [] as string[],
    failed: [] as { name: string; reason: string }[],
  }

  for (const file of files) {
    try {
      const relativePath = await resolveUploadPath(
        uploadDir,
        filePathParam,
        file.name,
      )
      if (isInvalidPath(relativePath)) {
        results.failed.push({
          name: file.name,
          reason: "Invalid path",
        })
        continue
      }

      const savePath = path.join(uploadDir, relativePath)
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
    return renderFileListResponse(c, uploadDir, filePathParam || "")
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
  const uploadDir = getUploadDir(c)

  if (isInvalidPath(filePathParam)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  const targetPath = path.join(uploadDir, filePathParam)
  let redirectPath = "/"
  try {
    const stat = await fsStat(targetPath)
    if (stat.isDirectory()) {
      const parentOfDir = path.dirname(targetPath)
      redirectPath = path.relative(uploadDir, parentOfDir)
      await rm(targetPath, { recursive: true, force: true })
    } else {
      const dirOfFile = path.dirname(targetPath)
      redirectPath = path.relative(uploadDir, dirOfFile)
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

  if (redirectPath === "") {
    redirectPath = ""
  } else {
    redirectPath = `${redirectPath.replace(/\\/g, "/")}`
  }

  return renderFileListResponse(c, uploadDir, redirectPath, {
    encodeRedirectPath: false,
  })
}

export async function mkdirHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    folder: string
  }
  const { path: dirPathParam, folder } = validatedData
  const uploadDir = getUploadDir(c)

  if (isInvalidPath(dirPathParam) || isInvalidNodeName(folder)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  await ensureUploadDirExists(uploadDir)
  const targetDir = path.join(uploadDir, dirPathParam)
  try {
    await mkdir(path.join(targetDir, folder), { recursive: false })
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "EEXIST")) {
      return alreadyExistsResponse(c, folder)
    }
    throw err
  }

  return renderFileListResponse(c, uploadDir, dirPathParam || "")
}

export async function createFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    file: string
  }
  const { path: dirPathParam, file } = validatedData
  const uploadDir = getUploadDir(c)

  if (isInvalidPath(dirPathParam) || isInvalidNodeName(file)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  await ensureUploadDirExists(uploadDir)
  const targetDir = path.join(uploadDir, dirPathParam)

  try {
    await writeFile(path.join(targetDir, file), "", { flag: "wx" })
  } catch (err: unknown) {
    if (isNodeErrorCode(err, "EEXIST")) {
      return alreadyExistsResponse(c, file)
    }
    throw err
  }

  return renderFileListResponse(c, uploadDir, dirPathParam || "")
}

export async function renameHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    name: string
  }
  const { path: currentPathParam, name } = validatedData
  const uploadDir = getUploadDir(c)

  if (isInvalidPath(currentPathParam) || isInvalidNodeName(name)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  const parentPath = path.dirname(currentPathParam)
  const normalizedParentPath =
    parentPath === "." ? "" : parentPath.replace(/\\/g, "/")
  const currentName = path.basename(currentPathParam)

  if (currentName === name) {
    return renderFileListResponse(c, uploadDir, normalizedParentPath)
  }

  const sourcePath = path.join(uploadDir, currentPathParam)
  const destinationRelativePath = normalizedParentPath
    ? path.join(normalizedParentPath, name)
    : name
  const destinationPath = path.join(uploadDir, destinationRelativePath)

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

  return renderFileListResponse(c, uploadDir, normalizedParentPath)
}

export async function updateFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    content: string
  }
  const { path: filePathParam, content } = validatedData
  const uploadDir = getUploadDir(c)

  if (isInvalidPath(filePathParam)) {
    return errorResponse(c, "PathError", "Invalid path", 400)
  }

  const targetPath = path.join(uploadDir, filePathParam)
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
