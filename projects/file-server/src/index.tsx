import type { Stats } from "node:fs"
import {
  stat as fsStat,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises"
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

// パスのバリデーション
function isInvalidPath(p: string): boolean {
  return p.includes("..") || path.isAbsolute(p) || p.startsWith("/")
}

// アップロードパス解決用関数
async function resolveUploadPath(baseDir: string, filePathParam: string | undefined, fileName: string): Promise<string> {
  if (!filePathParam || filePathParam === "") return fileName
  const fullPath = path.join(baseDir, filePathParam)
  try {
    const stat = await fsStat(fullPath)
    if (stat.isDirectory()) {
      return path.join(filePathParam, fileName)
    } else {
      return filePathParam
    }
  } catch {
    // 存在しない場合は、末尾が/ならディレクトリ扱い
    if (filePathParam.endsWith("/")) {
      return filePathParam + fileName
    }
    return filePathParam
  }
}

// ファイル・ディレクトリ一覧取得
app.get("/api/*", async (c) => {
  const uploadDir = env(c).UPLOAD_DIR || "./tmp"
  const subPath = c.req.path.replace(/^\/api\/?/, "")
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

// ファイルアップロード
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
    const relativePath = await resolveUploadPath(uploadDir, filePathParam, file.name)
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
    return c.json({})
  },
)

// ファイル削除
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

app.get("/", async (c) => {
  const uploadDir = env(c).UPLOAD_DIR || "./tmp"
  const requestPath = c.req.query("path") || ""
  if (isInvalidPath(requestPath)) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
  }
  const resolvedDir = path.join(uploadDir, requestPath)
  let stat: Stats
  try {
    stat = await fsStat(resolvedDir)
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
            name: "NotFound",
            message: "File or directory does not exist",
          },
        },
        400,
      )
    } else {
      throw err
    }
  }
  if (stat.isFile()) {
    // ファイルの場合は内容を返すエンドポイントへリダイレクト
    return c.redirect(`/file?path=${encodeURIComponent(requestPath)}`)
  }
  // ディレクトリの場合は一覧を返す
  let files: { name: string; type: "file" | "dir" }[] = []
  try {
    const dirents = await readdir(resolvedDir, { withFileTypes: true })
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
  return c.render(
    <form action="/api/upload" method="post" enctype="multipart/form-data">
      {/* パンくずリストの追加 */}
      <nav style={{ marginBottom: "1em" }}>
        {(() => {
          // requestPathを"/"で分割し、各階層のリンクを生成
          const parts = requestPath.split("/").filter(Boolean)
          const crumbs = []
          let acc = ""
          // ルート
          crumbs.push(
            <span key="root">
              <a href="/">root</a>
              {parts.length > 0 ? " / " : ""}
            </span>
          )
          parts.forEach((part, idx) => {
            acc += (acc ? "/" : "") + part
            const isLast = idx === parts.length - 1
            crumbs.push(
              <span key={acc}>
                <a href={`/?path=${encodeURIComponent(acc)}`}>{part}</a>
                {!isLast ? " / " : ""}
              </span>
            )
          })
          return crumbs
        })()}
      </nav>
      <hr/>
      <ul>
        {files.map((file) => (
          <li key={file.name}>
            <a
              href={`/?path=${encodeURIComponent(path.join(requestPath, file.name))}`}
            >
              {file.name}
              {file.type === "dir" ? "/" : ""}
            </a>
          </li>
        ))}
      </ul>
      <input type="hidden" name="path" value={requestPath} />
      <input type="file" name="file" required />
      <button type="submit">Upload</button>
    </form>,
  )
})

app.get("/file", async (c) => {
  const uploadDir = env(c).UPLOAD_DIR || "./tmp"
  const requestPath = c.req.query("path") || ""
  if (isInvalidPath(requestPath)) {
    return c.json(
      {
        success: false,
        error: { name: "PathError", message: "Invalid path" },
      },
      400,
    )
  }
  const resolvedFile = path.join(uploadDir, requestPath)
  let stat: Stats
  try {
    stat = await fsStat(resolvedFile)
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
          error: { name: "NotFound", message: "File does not exist" },
        },
        400,
      )
    } else {
      throw err
    }
  }
  if (!stat.isFile()) {
    return c.json(
      {
        success: false,
        error: { name: "NotAFile", message: "Not a file" },
      },
      400,
    )
  }
  const content = await readFile(resolvedFile, "utf-8")
  return c.render(<pre>{content}</pre>)
})

export default app
