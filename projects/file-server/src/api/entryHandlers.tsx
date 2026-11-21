import {
  stat as fsStat,
  mkdir,
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
import { normalizeRelativePath } from "../utils/fileUtils"
import { isNodeErrorCode } from "../utils/nodeError"
import { isPathTraversal } from "../utils/pathTraversal"
import {
  errorResponse,
  forbiddenResponse,
  getUploadDir,
  getUser,
  invalidPathResponse,
} from "../utils/requestUtils"
import { requireWritePermission } from "../utils/virtualPath"

function isInvalidNodeName(name: string): boolean {
  return (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  )
}

export async function deleteFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
  }
  const { path: filePathParam } = validatedData
  const baseDir = getUploadDir(c)
  const user = getUser(c)

  if (isPathTraversal(filePathParam)) {
    return invalidPathResponse(c)
  }

  if (!requireWritePermission(user, filePathParam)) {
    return forbiddenResponse(c)
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
  const user = getUser(c)

  if (isPathTraversal(dirPathParam) || isInvalidNodeName(folder)) {
    return invalidPathResponse(c)
  }

  if (!requireWritePermission(user, dirPathParam)) {
    return forbiddenResponse(c)
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
  const user = getUser(c)

  if (isPathTraversal(dirPathParam) || isInvalidNodeName(file)) {
    return invalidPathResponse(c)
  }

  if (!requireWritePermission(user, dirPathParam)) {
    return forbiddenResponse(c)
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
  const user = getUser(c)

  if (isPathTraversal(currentPathParam) || isInvalidNodeName(name)) {
    return invalidPathResponse(c)
  }

  if (!requireWritePermission(user, currentPathParam)) {
    return forbiddenResponse(c)
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
