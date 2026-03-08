import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import z from "zod"
import {
  createFileHandler,
  deleteFileHandler,
  listFilesHandler,
  mkdirHandler,
  updateFileHandler,
  uploadFileHandler,
} from "../api/handlers"
import type { AppBindings } from "../types"

const apiRoutes = new Hono<AppBindings>()

// ファイル・ディレクトリ一覧取得（JSON API）
apiRoutes.get("/*", listFilesHandler)

// ファイルアップロード（複数ファイル対応、最大10件）
apiRoutes.post(
  "/upload",
  zValidator(
    "form",
    z.object({
      files: z.preprocess(
        (val) => (Array.isArray(val) ? val : val ? [val] : []),
        z.array(z.instanceof(File)).max(10),
      ),
      path: z.string().optional(),
    }),
  ),
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
