import type { Stats } from "node:fs"
import { stat as fsStat, readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { env } from "hono/adapter"
import * as mime from "mime-types"
import z from "zod"
import {
  deleteFileHandler,
  listFilesHandler,
  mkdirHandler,
  uploadFileHandler,
} from "./api/handlers"
import { isInvalidPath, sortFiles } from "./utils/fileUtils"
import { formatFileSize, formatTimestamp } from "./utils/formatters"

const app = new Hono<{
  Bindings: {
    UPLOAD_DIR: string
  }
}>()

// ファイル・ディレクトリ一覧取得
app.get("/api/*", listFilesHandler)

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
  uploadFileHandler,
)

// ファイル削除
app.post(
  "/api/delete",
  zValidator(
    "form",
    z.object({
      path: z.string(),
    }),
  ),
  deleteFileHandler,
)

// 空ディレクトリ作成API
app.post(
  "/api/mkdir",
  zValidator(
    "form",
    z.object({
      path: z.string(),
      folder: z.string(),
    }),
  ),
  mkdirHandler,
)

app.get("/", async (c) => {
  const uploadDir = env(c).UPLOAD_DIR || "./tmp"
  const requestPath = decodeURIComponent(c.req.query("path") || "")
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
    return c.redirect(`/file?path=${requestPath}`)
  }
  // ディレクトリの場合は一覧を返す
  let files: {
    name: string
    type: "file" | "dir"
    size?: number
    mtime?: Date
  }[] = []
  try {
    const dirents = await readdir(resolvedDir, { withFileTypes: true })
    files = await Promise.all(
      dirents.map(async (ent) => {
        if (ent.isDirectory()) {
          const stat = await fsStat(path.join(resolvedDir, ent.name))
          return { name: ent.name, type: "dir", mtime: stat.mtime }
        } else {
          const stat = await fsStat(path.join(resolvedDir, ent.name))
          return {
            name: ent.name,
            type: "file",
            size: stat.size,
            mtime: stat.mtime,
          }
        }
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
    } else {
      throw err
    }
  }

  const sortedFiles = sortFiles(files)

  return c.render(
    <div>
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
            </span>,
          )
          parts.forEach((part, idx) => {
            acc += (acc ? "/" : "") + part
            const isLast = idx === parts.length - 1
            crumbs.push(
              <span key={acc}>
                <a href={`/?path=${encodeURIComponent(acc)}`}>{part}</a>
                {!isLast ? " / " : ""}
              </span>,
            )
          })
          return crumbs
        })()}
      </nav>
      <hr />
      <ul>
        {sortedFiles.map((file) => (
          <li
            key={file.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <a
              href={`/?path=${encodeURIComponent(
                path.join(requestPath, file.name),
              )}`}
            >
              {file.name}
              {file.type === "dir" ? "/" : ""}
            </a>
            <div style={{ display: "flex", gap: "1em" }}>
              {/* ファイルサイズ表示（ファイルのみ） */}
              {file.type === "file" && (
                <div
                  style={{
                    width: "120px",
                    textAlign: "right",
                    margin: "0 1em",
                  }}
                >
                  {formatFileSize(file.size || 0)}
                </div>
              )}
              {/* タイムスタンプ表示 */}
              <div style={{ width: "180px", textAlign: "right" }}>
                {file.mtime && formatTimestamp(new Date(file.mtime))}
              </div>
              <div
                style={{ width: "80px", display: "flex", alignItems: "center" }}
              >
                <form method="post" action="/api/delete">
                  <input
                    type="hidden"
                    name="path"
                    value={path.join(requestPath, file.name)}
                  />
                  <button type="submit">Delete</button>
                </form>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <form action="/api/mkdir" method="post" style={{ marginBottom: "1em" }}>
        <input
          type="hidden"
          name="path"
          value={
            requestPath
              ? requestPath + (requestPath.endsWith("/") ? "" : "/")
              : ""
          }
        />
        <input
          type="text"
          name="folder"
          placeholder="New folder name"
          required
          style={{ marginRight: "0.5em" }}
        />
        <button type="submit">Create Folder</button>
      </form>
      <form action="/api/upload" method="post" enctype="multipart/form-data">
        <input type="hidden" name="path" value={requestPath} />
        <input type="file" name="file" required />
        <button type="submit">Upload</button>
      </form>
    </div>,
  )
})

app.get("/file", async (c) => {
  const uploadDir = env(c).UPLOAD_DIR || "./tmp"
  const requestPath = decodeURIComponent(c.req.query("path") || "")
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
  // MIMEタイプ判定
  const mimeType = mime.lookup(resolvedFile) || "application/octet-stream"
  const isText =
    /^text\//.test(mimeType) || /json$|javascript$|xml$/.test(mimeType)

  if (isText) {
    const content = await readFile(resolvedFile, "utf-8")
    return c.render(<pre>{content}</pre>)
  } else {
    const contentBuffer = await readFile(resolvedFile)
    const isImageOrVideoOrPdf =
      mimeType.startsWith("image/") ||
      mimeType.startsWith("video/") ||
      mimeType === "application/pdf"
    const headers: Record<string, string> = { "Content-Type": mimeType }
    if (!isImageOrVideoOrPdf) {
      headers["Content-Disposition"] = `attachment; filename="${path.basename(
        resolvedFile,
      )}"`
    }
    const content = contentBuffer.buffer.slice(
      contentBuffer.byteOffset,
      contentBuffer.byteOffset + contentBuffer.byteLength,
    ) as ArrayBuffer
    return new Response(content, { headers })
  }
})

export default app
