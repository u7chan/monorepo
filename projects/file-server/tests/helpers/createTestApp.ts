import type { Hono } from "hono"
import { createApp } from "../../src/app"
import type { AppBindings } from "../../src/types"
import { resetUsersCacheForTests } from "../../src/utils/userConfigCache"

export interface TestAppOptions {
	uploadDir: string
	usersFile?: string
	sessionSecret?: string
}

export async function createTestApp(
	options: TestAppOptions,
): Promise<Hono<AppBindings>> {
	process.env.UPLOAD_DIR = options.uploadDir
	if (options.usersFile) {
		process.env.USERS_FILE = options.usersFile
	} else {
		delete process.env.USERS_FILE
	}
	if (options.sessionSecret) {
		process.env.SESSION_SECRET = options.sessionSecret
	} else {
		delete process.env.SESSION_SECRET
	}

	resetUsersCacheForTests()

	return createApp({
		uploadDir: options.uploadDir,
		usersFile: options.usersFile,
		sessionSecret: options.sessionSecret,
	})
}
