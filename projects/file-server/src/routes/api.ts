import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import z from "zod"
import {
  deleteFileHandler,
  listFilesHandler,
  mkdirHandler,
  uploadFileHandler,
} from "../api/handlers"
import type { AppBindings } from "../types"

const apiRoutes = new Hono<AppBindings>()

// ファイル・ディレクトリ一覧取得（JSON API）
apiRoutes.get("/*", listFilesHandler)

// ファイルアップロード
apiRoutes.post(
  "/upload",
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

export default apiRoutes
