import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import { authMiddleware, requireAuthMiddleware } from "./middleware/auth"
import adminRoutes from "./routes/admin"
import apiRoutes from "./routes/api"
import authRoutes from "./routes/auth"
import browseRoutes from "./routes/browse"
import fileRoutes from "./routes/file"
import publicRoutes from "./routes/public"
import type { AppBindings } from "./types"
import {
  DEFAULT_UPLOAD_DIR,
  ensureSessionSecret,
  resolveAuthConfig,
} from "./utils/auth"
import { bootstrapAdminUser } from "./utils/bootstrap"

export interface CreateAppOptions {
  uploadDir?: string
  authDir?: string
  initialAdminPassword?: string
}

export async function createApp(
  options: CreateAppOptions = {},
): Promise<Hono<AppBindings>> {
  const uploadDir =
    options.uploadDir ?? process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR
  const authConfig = resolveAuthConfig({
    AUTH_DIR: options.authDir ?? process.env.AUTH_DIR,
    SESSION_SECRET: process.env.SESSION_SECRET,
    USERS_FILE: process.env.USERS_FILE,
  })
  const initialAdminPassword =
    options.initialAdminPassword ?? process.env.INITIAL_ADMIN_PASSWORD

  await mkdir(path.join(uploadDir, "public"), { recursive: true })
  await mkdir(path.join(uploadDir, "private"), { recursive: true })

  if (authConfig.authDir) {
    await bootstrapAdminUser(authConfig.authDir, initialAdminPassword)
    await ensureSessionSecret(authConfig.authDir)
  }

  const app = new Hono<AppBindings>()

  app.use("*", authMiddleware)
  app.use("*", requireAuthMiddleware)

  app.route("/", authRoutes)
  app.route("/public", publicRoutes)
  app.route("/api", apiRoutes)
  app.route("/admin", adminRoutes)
  app.route("/", browseRoutes)
  app.route("/file", fileRoutes)

  return app
}
