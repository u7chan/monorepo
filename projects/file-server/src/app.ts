import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { Hono } from "hono"
import { authMiddleware, requireAuthMiddleware } from "./middleware/auth"
import apiRoutes from "./routes/api"
import authRoutes from "./routes/auth"
import browseRoutes from "./routes/browse"
import fileRoutes from "./routes/file"
import publicRoutes from "./routes/public"
import type { AppBindings } from "./types"
import { DEFAULT_UPLOAD_DIR, validateAuthConfig } from "./utils/auth"

export interface CreateAppOptions {
	uploadDir?: string
	usersFile?: string
	sessionSecret?: string
}

export async function createApp(
	options: CreateAppOptions = {},
): Promise<Hono<AppBindings>> {
	const uploadDir =
		options.uploadDir ?? process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR
	const usersFile = options.usersFile ?? process.env.USERS_FILE
	const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET

	validateAuthConfig(usersFile, sessionSecret)

	await mkdir(path.join(uploadDir, "public"), { recursive: true })
	await mkdir(path.join(uploadDir, "private"), { recursive: true })

	const app = new Hono<AppBindings>()

	app.use("*", authMiddleware)
	app.use("*", requireAuthMiddleware)

	app.route("/", authRoutes)
	app.route("/public", publicRoutes)
	app.route("/api", apiRoutes)
	app.route("/", browseRoutes)
	app.route("/file", fileRoutes)

	return app
}
