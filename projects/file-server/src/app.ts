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
import { DEFAULT_UPLOAD_DIR, validateAuthConfig } from "./utils/auth"
import { bootstrapAdminUser } from "./utils/bootstrap"

export interface CreateAppOptions {
	uploadDir?: string
	sessionSecret?: string
	initialAdminPassword?: string
}

export async function createApp(
	options: CreateAppOptions = {},
): Promise<Hono<AppBindings>> {
	const uploadDir =
		options.uploadDir ?? process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR
	const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET
	const initialAdminPassword =
		options.initialAdminPassword ?? process.env.INITIAL_ADMIN_PASSWORD

	validateAuthConfig(sessionSecret)

	await mkdir(path.join(uploadDir, "public"), { recursive: true })
	await mkdir(path.join(uploadDir, "private"), { recursive: true })

	if (sessionSecret) {
		await bootstrapAdminUser(uploadDir, initialAdminPassword)
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
