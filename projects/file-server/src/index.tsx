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
import { FileListContent } from "./components/FileList"
import { FileViewer } from "./components/FileViewer"
import { PageShell } from "./components/PageShell"
import { isInvalidPath } from "./utils/fileUtils"

const app = new Hono<{
  Bindings: {
    UPLOAD_DIR: string
  }
}>()

// ファイル・ディレクトリ一覧取得（JSON API）
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

// ディレクトリ内のファイル一覧を取得する共通関数
async function getFileList(uploadDir: string, requestPath: string) {
  const resolvedDir = path.join(uploadDir, requestPath)
  const dirents = await readdir(resolvedDir, { withFileTypes: true })
  return await Promise.all(
    dirents.map(async (ent) => {
      if (ent.isDirectory()) {
        const stat = await fsStat(path.join(resolvedDir, ent.name))
        return { name: ent.name, type: "dir" as const, mtime: stat.mtime }
      } else {
        const stat = await fsStat(path.join(resolvedDir, ent.name))
        return {
          name: ent.name,
          type: "file" as const,
          size: stat.size,
          mtime: stat.mtime,
        }
      }
    }),
  )
}

// ルート: フルHTMLシェルまたは部分HTMLを返す
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
    // ファイルの場合はファイル閲覧エンドポイントへリダイレクト
    return c.redirect(`/file?path=${encodeURIComponent(requestPath)}`)
  }

  // ディレクトリの場合は一覧を返す
  const files = await getFileList(uploadDir, requestPath)
  const isHtmxRequest = c.req.header("HX-Request") === "true"

  if (isHtmxRequest) {
    // htmxリクエスト: 部分HTMLを返す
    return c.html(<FileListContent files={files} requestPath={requestPath} />)
  } else {
    // 通常リクエスト: フルHTMLシェルを返す
    return c.html(
      <PageShell>
        <FileListContent files={files} requestPath={requestPath} />
      </PageShell>,
    )
  }
})

// /browse: 一覧部分HTML（htmx用）
app.get("/browse", async (c) => {
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
            message: "Directory does not exist",
          },
        },
        400,
      )
    } else {
      throw err
    }
  }

  if (!stat.isDirectory()) {
    return c.json(
      {
        success: false,
        error: { name: "NotADirectory", message: "Not a directory" },
      },
      400,
    )
  }

  const files = await getFileList(uploadDir, requestPath)
  return c.html(<FileListContent files={files} requestPath={requestPath} />)
})

// /file: ファイル閲覧部分HTML（htmx用）
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

  const mimeType = mime.lookup(resolvedFile) || "application/octet-stream"
  const isText =
    /^text\//.test(mimeType) || /json$|javascript$|xml$/.test(mimeType)
  const isHtmxRequest = c.req.header("HX-Request") === "true"

  // バイナリファイルの生データ用エンドポイントへのリダイレクトを避けるため、直接URLを構築
  if (isText) {
    const content = await readFile(resolvedFile, "utf-8")
    if (isHtmxRequest) {
      return c.html(
        <FileViewer
          content={content}
          fileName={path.basename(resolvedFile)}
          path={requestPath}
        />,
      )
    } else {
      return c.html(
        <PageShell>
          <FileViewer
            content={content}
            fileName={path.basename(resolvedFile)}
            path={requestPath}
          />
        </PageShell>,
      )
    }
  } else {
    // バイナリファイル（画像/動画/PDF）
    const isImageOrVideoOrPdf =
      mimeType.startsWith("image/") ||
      mimeType.startsWith("video/") ||
      mimeType === "application/pdf"

    if (isImageOrVideoOrPdf) {
      if (isHtmxRequest) {
        return c.html(
          <FileViewer
            mimeType={mimeType}
            fileName={path.basename(resolvedFile)}
            path={requestPath}
          />,
        )
      } else {
        return c.html(
          <PageShell>
            <FileViewer
              mimeType={mimeType}
              fileName={path.basename(resolvedFile)}
              path={requestPath}
            />
          </PageShell>,
        )
      }
    } else {
      // その他のバイナリファイルはHTMX時はダウンロードリンクを表示、通常時はダウンロード
      if (isHtmxRequest) {
        return c.html(
          <FileViewer
            fileName={path.basename(resolvedFile)}
            path={requestPath}
          />,
        )
      } else {
        const contentBuffer = await readFile(resolvedFile)
        const headers: Record<string, string> = {
          "Content-Type": mimeType,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolvedFile))}`,
        }
        const content = contentBuffer.buffer.slice(
          contentBuffer.byteOffset,
          contentBuffer.byteOffset + contentBuffer.byteLength,
        ) as ArrayBuffer
        return new Response(content, { headers })
      }
    }
  }
})

// /file/raw: バイナリファイルの生データ（画像/動画/PDF用）
app.get("/file/raw", async (c) => {
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

  const mimeType = mime.lookup(resolvedFile) || "application/octet-stream"
  const contentBuffer = await readFile(resolvedFile)
  const headers: Record<string, string> = { "Content-Type": mimeType }

  const content = contentBuffer.buffer.slice(
    contentBuffer.byteOffset,
    contentBuffer.byteOffset + contentBuffer.byteLength,
  ) as ArrayBuffer
  return new Response(content, { headers })
})

export default app
