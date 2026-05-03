import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import z from "zod"
import {
  createFileHandler,
  deleteFileHandler,
  listFilesHandler,
  mkdirHandler,
  moveHandler,
  movePickerHandler,
  renameHandler,
  updateFileHandler,
  uploadFileHandler,
} from "../api/handlers"
import type { AppBindings } from "../types"

const apiRoutes = new Hono<AppBindings>()

// 移動先ディレクトリピッカー（HTMX）
apiRoutes.get("/move/picker", movePickerHandler)

// ファイル・ディレクトリ移動
apiRoutes.post(
  "/move",
  zValidator(
    "form",
    z.object({
      path: z.string(),
      destination: z.string(),
    }),
  ),
  moveHandler,
)

// ファイル・ディレクトリ一覧取得（JSON API）
apiRoutes.get("/*", listFilesHandler)

// ファイルアップロード（複数ファイル対応、最大10件）
apiRoutes.post(
  "/upload",
  uploadFileHandler,
)

// ファイル削除
apiRoutes.post(
  "/delete",
  zValidator(
    "form",
    z.object({
      path: z.string(),
    }),
  ),
  deleteFileHandler,
)

// 空ディレクトリ作成API
apiRoutes.post(
  "/mkdir",
  zValidator(
    "form",
    z.object({
      path: z.string(),
      folder: z.string(),
    }),
  ),
  mkdirHandler,
)

// 空ファイル作成API
apiRoutes.post(
  "/file",
  zValidator(
    "form",
    z.object({
      path: z.string(),
      file: z.string(),
    }),
  ),
  createFileHandler,
)

// ファイル内容更新API
apiRoutes.post(
  "/rename",
  zValidator(
    "form",
    z.object({
      path: z.string(),
      name: z.string(),
    }),
  ),
  renameHandler,
)

apiRoutes.post(
  "/update",
  zValidator(
    "form",
    z.object({
      path: z.string(),
      content: z.string(),
    }),
  ),
  updateFileHandler,
)

export default apiRoutes
