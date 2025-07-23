import { mkdir, readdir, unlink, writeFile } from "node:fs/promises"
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { env } from "hono/adapter"
import z from "zod"

import path = require("node:path")

const app = new Hono<{
  Bindings: {
    UPLOAD_DIR: string
  }
}>()

// /api/ または /api/サブパス で、そのパス配下のファイル一覧を返す
app.get("/api/*", async (c) => {
  const uploadDir = env(c).UPLOAD_DIR || "./tmp"
  // サブパスを取得
  const subPath = c.req.path.replace(/^\/api\/?/, "")
  // セキュリティ: '..'や絶対パスを禁止
  if (
    subPath.includes("..") ||
    path.isAbsolute(subPath) ||
    subPath.startsWith("/")
  ) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
  }
  const targetDir = path.join(uploadDir, subPath)
  let files: { name: string; type: "file" | "dir" }[] = []
  try {
    const dirents = await readdir(targetDir, { withFileTypes: true })
    files = dirents.map((ent) => ({
      name: ent.name,
      type: ent.isDirectory() ? "dir" : "file",
    }))
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
    } else {
      throw err
    }
  }
  return c.json({
    files,
  })
})

app.post(
  "/api/upload",
  zValidator(
    "form",
    z.object({
      file: z.instanceof(File),
      path: z.string().optional(),
    }),
  ),
  async (c) => {
    const { file, path: filePathParam } = c.req.valid("form")
    const uploadDir = env(c).UPLOAD_DIR || "./tmp"
    // パスが指定されていればそれを使う
    const relativePath = filePathParam ? filePathParam : file.name
    // セキュリティ: '..'や絶対パスを禁止
    if (
      relativePath.includes("..") ||
      path.isAbsolute(relativePath) ||
      relativePath.startsWith("/")
    ) {
      return c.json(
        {
          success: false,
          error: { name: "PathError", message: "Invalid path" },
        },
        400,
      )
    }
    const savePath = path.join(uploadDir, relativePath)
    // ディレクトリ作成
    const dir = path.dirname(savePath)
    await mkdir(dir, { recursive: true })
    const buffer = await file.arrayBuffer()
    await writeFile(savePath, Buffer.from(buffer))
    return c.json({})
  },
)

app.delete(
  "/api/delete",
  zValidator(
    "json",
    z.object({
      path: z.string(),
    }),
  ),
  async (c) => {
    const { path: filePathParam } = c.req.valid("json")
    const uploadDir = env(c).UPLOAD_DIR || "./tmp"
    // セキュリティ: '..'や絶対パスを禁止
    if (
      filePathParam.includes("..") ||
      path.isAbsolute(filePathParam) ||
      filePathParam.startsWith("/")
    ) {
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
      await unlink(targetPath)
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
      } else {
        throw err
      }
    }
    return c.json({})
  },
)
export default app
