import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Hono } from "hono"
import { createApp } from "../../src/app"
import type { AppBindings } from "../../src/types"
import {
  getSessionSecretFilePath,
  getUsersFilePath,
  resetSessionSecretCacheForTests,
} from "../../src/utils/auth"
import { resetUsersCacheForTests } from "../../src/utils/userConfigCache"

export interface TestAppOptions {
  uploadDir: string
  authDir?: string
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
  const authDir =
    options.authDir ??
    (options.sessionSecret || options.seedUsers || options.initialAdminPassword
      ? path.join(options.uploadDir, ".auth")
      : undefined)

  process.env.UPLOAD_DIR = options.uploadDir
  if (authDir) {
    process.env.AUTH_DIR = authDir
  } else {
    delete process.env.AUTH_DIR
  }
  delete process.env.USERS_FILE
  delete process.env.SESSION_SECRET
  if (options.initialAdminPassword) {
    process.env.INITIAL_ADMIN_PASSWORD = options.initialAdminPassword
  } else {
    delete process.env.INITIAL_ADMIN_PASSWORD
  }

  resetUsersCacheForTests()
  resetSessionSecretCacheForTests()

  if (authDir && options.sessionSecret) {
    await mkdir(authDir, { recursive: true })
    await writeFile(
      getSessionSecretFilePath(authDir),
      `${options.sessionSecret}\n`,
      "utf-8",
    )
  }

  if (authDir && options.seedUsers && options.seedUsers.length > 0) {
    const usersFile = getUsersFilePath(authDir)
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
    authDir,
    initialAdminPassword: options.initialAdminPassword,
  })
}
