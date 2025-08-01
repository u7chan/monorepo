import type { Stats } from "node:fs"
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
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { env } from "hono/adapter"
import * as mime from "mime-types"
import z from "zod"

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
async function resolveUploadPath(
  baseDir: string,
  filePathParam: string | undefined,
  fileName: string,
): Promise<string> {
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
  let files: { name: string; type: "file" | "dir"; size?: number }[] = []
  try {
    const dirents = await readdir(targetDir, { withFileTypes: true })
    files = await Promise.all(
      dirents.map(async (ent) => {
        if (ent.isDirectory()) {
          return { name: ent.name, type: "dir" }
        } else {
          // ファイルサイズ取得
          const stat = await fsStat(path.join(targetDir, ent.name))
          return { name: ent.name, type: "file", size: stat.size }
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
    return c.redirect(`/?path=${encodeURIComponent(filePathParam || "")}`, 301)
  },
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
  async (c) => {
    const { path: filePathParam } = c.req.valid("form")
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
    let redirectPath = "/"

    try {
      const stat = await fsStat(targetPath)
      if (stat.isDirectory()) {
        // ディレクトリの場合：親ディレクトリのパス
        const parentOfDir = path.dirname(targetPath)            // 削除したディレクトリの親ディレクトリ
        redirectPath = path.relative(uploadDir, parentOfDir)   // uploadDirからの相対パス
        await rm(targetPath, { recursive: true, force: true })
      } else {
        // ファイルの場合：ディレクトリパス
        const dirOfFile = path.dirname(targetPath)
        redirectPath = path.relative(uploadDir, dirOfFile)      // uploadDirからの相対パス
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
      } else {
        throw err
      }
    }

    if (redirectPath === "") {
      redirectPath = ""
    } else {
      redirectPath = `${redirectPath.replace(/\\/g, "/")}`
    }

    return c.redirect(`/?path=${redirectPath}`, 301)
  },
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
  async (c) => {
    const { path: dirPathParam, folder } = c.req.valid("form")
    const uploadDir = env(c).UPLOAD_DIR || "./tmp"
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
      } else {
        throw err
      }
    }
    return c.redirect(`/?path=${encodeURIComponent(dirPathParam || "")}`, 301)
  },
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
  let files: { name: string; type: "file" | "dir"; size?: number }[] = []
  try {
    const dirents = await readdir(resolvedDir, { withFileTypes: true })
    files = await Promise.all(
      dirents.map(async (ent) => {
        if (ent.isDirectory()) {
          return { name: ent.name, type: "dir" }
        } else {
          const stat = await fsStat(path.join(resolvedDir, ent.name))
          return { name: ent.name, type: "file", size: stat.size }
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
        {files.map((file) => (
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
            {/* ファイルサイズ表示（ファイルのみ） */}
            {file.type === "file" && (
              <span style={{ margin: "0 1em" }}>{file.size} bytes</span>
            )}
            <form method="post" action="/api/delete">
              <input
                type="hidden"
                name="path"
                value={path.join(requestPath, file.name)}
              />
              <button type="submit">Delete</button>
            </form>
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
    const content = await readFile(resolvedFile)
    const isImageOrVideoOrPdf =
      mimeType.startsWith("image/") ||
      mimeType.startsWith("video/") ||
      mimeType === "application/pdf"
    const headers: Record<string, string> = { "Content-Type": mimeType }
    if (!isImageOrVideoOrPdf) {
      headers["Content-Disposition"] = `attachment; filename=\"${path.basename(
        resolvedFile,
      )}\"`
    }
    return new Response(content, { headers })
  }
})

export default app
