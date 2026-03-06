import {
  stat as fsStat,
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import * as path from "node:path"
import type { Context } from "hono"
import { FileList } from "../components/FileList"
import type { AppBindings } from "../types"
import { ensureUploadDirExists, getFileList } from "../utils/fileListing"
import { isInvalidPath, resolveUploadPath, sortFiles } from "../utils/fileUtils"
import { getUploadDir, isHtmxRequest } from "../utils/requestUtils"

const BASE_PATH_REGEX = /^\/api\/?/

function isInvalidFolderName(folder: string): boolean {
  return (
    !folder ||
    folder === "." ||
    folder === ".." ||
    folder.includes("/") ||
    folder.includes("\\")
  )
}

export async function listFilesHandler(c: Context<AppBindings>) {
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

  await ensureUploadDirExists(uploadDir)
  const targetDir = path.join(uploadDir, subPath)

  let files: { name: string; type: "file" | "dir"; size?: number }[] = []
  try {
    const dirents = await readdir(targetDir, { withFileTypes: true })
    files = await Promise.all(
      dirents.map(async (ent) => {
        if (ent.isDirectory()) {
          return { name: ent.name, type: "dir" as const }
        }
        const stat = await fsStat(path.join(targetDir, ent.name))
        return { name: ent.name, type: "file" as const, size: stat.size }
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
    const parentPath = filePathParam || ""
    const fileList = await getFileList(uploadDir, parentPath)
    return c.html(<FileList files={fileList} requestPath={parentPath} />)
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

  if (isHtmxRequest(c)) {
    const files = await getFileList(uploadDir, redirectPath)
    return c.html(<FileList files={files} requestPath={redirectPath} />)
  }

  return c.redirect(`/?path=${redirectPath}`, 301)
}

export async function mkdirHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    folder: string
  }
  const { path: dirPathParam, folder } = validatedData
  const uploadDir = getUploadDir(c)

  if (isInvalidPath(dirPathParam) || isInvalidFolderName(folder)) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
  }

  await ensureUploadDirExists(uploadDir)
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

  if (isHtmxRequest(c)) {
    const files = await getFileList(uploadDir, dirPathParam || "")
    return c.html(<FileList files={files} requestPath={dirPathParam || ""} />)
  }

  return c.redirect(`/?path=${encodeURIComponent(dirPathParam || "")}`, 301)
}

export async function updateFileHandler(c: Context<AppBindings>) {
  const validatedData = c.req.valid("form" as never) as {
    path: string
    content: string
  }
  const { path: filePathParam, content } = validatedData
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
  try {
    const stat = await fsStat(targetPath)
    if (!stat.isFile()) {
      return c.json(
        {
          success: false,
          error: { name: "NotAFile", message: "Path is not a file" },
        },
        400,
      )
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
          error: { name: "FileNotFound", message: "File does not exist" },
        },
        400,
      )
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
