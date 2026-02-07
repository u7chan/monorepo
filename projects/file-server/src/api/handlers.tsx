import { stat as fsStat, mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { Context } from "hono"
import { FileList } from "../components/FileList"
import { isInvalidPath, resolveUploadPath, sortFiles } from "../utils/fileUtils"
import { getFileList } from "../utils/fileListing"
import { getUploadDir, isHtmxRequest } from "../utils/requestUtils"

const BASE_PATH_REGEX = /^\/api\/?/

export async function listFilesHandler(c: Context) {
  const uploadDir = getUploadDir(c)
  const subPath = c.req.path.replace(BASE_PATH_REGEX, "")
  if (isInvalidPath(subPath)) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
  }
  const targetDir = path.join(uploadDir, subPath)
  let files: { name: string; type: "file" | "dir"; size?: number }[] = []
  try {
    const dirents = await readdir(targetDir, { withFileTypes: true })
    files = await Promise.all(
      dirents.map(async (ent) => {
        if (ent.isDirectory()) {
          return { name: ent.name, type: "dir" }
        }
        const stat = await fsStat(path.join(targetDir, ent.name))
        return { name: ent.name, type: "file", size: stat.size }
      }),
    )
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return c.json(
        {
          success: false,
          error: { name: "DirNotFound", message: "Directory does not exist" },
        },
        400,
      )
    }
    throw err
  }

  const sortedFiles = sortFiles(files)

  return c.json({ files: sortedFiles })
}

export async function uploadFileHandler(
  c: Context<{ Bindings: { UPLOAD_DIR: string } }>,
) {
  const validatedData = c.req.valid("form" as never) as {
    file: File
    path?: string
  }
  const { file, path: filePathParam } = validatedData
  const uploadDir = getUploadDir(c)
  const relativePath = await resolveUploadPath(
    uploadDir,
    filePathParam,
    file.name,
  )
  if (isInvalidPath(relativePath)) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
  }
  const savePath = path.join(uploadDir, relativePath)
  await mkdir(path.dirname(savePath), { recursive: true })
  const buffer = await file.arrayBuffer()
  await writeFile(savePath, Buffer.from(buffer))

  // For htmx requests, return the updated file list
  if (isHtmxRequest(c)) {
    const parentPath = filePathParam || ""
    const files = await getFileList(uploadDir, parentPath)
    return c.html(<FileList files={files} requestPath={parentPath} />)
  }

  return c.redirect(`/?path=${encodeURIComponent(filePathParam || "")}`, 301)
}

export async function deleteFileHandler(
  c: Context<{ Bindings: { UPLOAD_DIR: string } }>,
) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
  }
  const { path: filePathParam } = validatedData
  const uploadDir = getUploadDir(c)
  if (isInvalidPath(filePathParam)) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
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
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return c.json(
        {
          success: false,
          error: {
            name: "FileNotFound",
            message: "File or directory does not exist",
          },
        },
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

  // For htmx requests, return the updated file list
  if (isHtmxRequest(c)) {
    const files = await getFileList(uploadDir, redirectPath)
    return c.html(<FileList files={files} requestPath={redirectPath} />)
  }

  return c.redirect(`/?path=${redirectPath}`, 301)
}

export async function mkdirHandler(
  c: Context<{ Bindings: { UPLOAD_DIR: string } }>,
) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    folder: string
  }
  const { path: dirPathParam, folder } = validatedData
  const uploadDir = getUploadDir(c)
  if (isInvalidPath(dirPathParam)) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
  }
  const targetDir = path.join(uploadDir, dirPathParam)
  try {
    await mkdir(path.join(targetDir, folder), { recursive: false })
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "EEXIST"
    ) {
      return c.json(
        {
          success: false,
          error: {
            name: "AlreadyExists",
            message: "Directory already exists",
          },
        },
        400,
      )
    }
    throw err
  }

  // For htmx requests, return the updated file list
  if (isHtmxRequest(c)) {
    const files = await getFileList(uploadDir, dirPathParam || "")
    return c.html(<FileList files={files} requestPath={dirPathParam || ""} />)
  }

  return c.redirect(`/?path=${encodeURIComponent(dirPathParam || "")}`, 301)
}
