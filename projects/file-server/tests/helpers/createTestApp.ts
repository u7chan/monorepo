import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Hono } from "hono"
import { createApp } from "../../src/app"
import type { AppBindings } from "../../src/types"
import { getUsersFilePath } from "../../src/utils/auth"
import { resetUsersCacheForTests } from "../../src/utils/userConfigCache"

export interface TestAppOptions {
	uploadDir: string
	sessionSecret?: string
	initialAdminPassword?: string
	seedUsers?: Array<{
		username: string
		password: string
		role?: "admin" | "user"
	}>
}

export async function createTestApp(
	options: TestAppOptions,
): Promise<Hono<AppBindings>> {
	process.env.UPLOAD_DIR = options.uploadDir
	delete process.env.USERS_FILE
	if (options.sessionSecret) {
		process.env.SESSION_SECRET = options.sessionSecret
	} else {
		delete process.env.SESSION_SECRET
	}
	if (options.initialAdminPassword) {
		process.env.INITIAL_ADMIN_PASSWORD = options.initialAdminPassword
	} else {
		delete process.env.INITIAL_ADMIN_PASSWORD
	}

	resetUsersCacheForTests()

	if (options.seedUsers && options.seedUsers.length > 0) {
		const usersFile = getUsersFilePath(options.uploadDir)
		await mkdir(path.dirname(usersFile), { recursive: true })
		const userConfigs = await Promise.all(
			options.seedUsers.map(async (user) => ({
				username: user.username,
				passwordHash: await Bun.password.hash(user.password, {
					algorithm: "bcrypt",
					cost: 4,
				}),
				role: user.role ?? "user",
				sessionVersion: 0,
			})),
		)
		await writeFile(usersFile, JSON.stringify(userConfigs), "utf-8")
	}

	return createApp({
		uploadDir: options.uploadDir,
		sessionSecret: options.sessionSecret,
		initialAdminPassword: options.initialAdminPassword,
	})
}
