import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Hono } from "hono"
import { createApp } from "../../src/app"
import type { AppBindings } from "../../src/types"
import {
  getSessionSecretFilePath,
  resetSessionSecretCacheForTests,
} from "../../src/utils/sessionSecret"
import { resetUsersCacheForTests } from "../../src/utils/userConfigCache"
import { type PlainUser, writeUsersFile } from "./userStore"

export interface TestAppOptions {
  uploadDir: string
  authDir?: string
  sessionSecret?: string
  initialAdminPassword?: string
  seedUsers?: PlainUser[]
}

/**
 * Why not delete only the variables this call sets: a previous test file may
 * have left AUTH_DIR or INITIAL_ADMIN_PASSWORD behind, so each call writes
 * every variable the app reads, using undefined to delete it.
 */
function applyEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

export async function createTestApp(
  options: TestAppOptions,
): Promise<Hono<AppBindings>> {
  const authDir =
    options.authDir ??
    (options.sessionSecret || options.seedUsers || options.initialAdminPassword
      ? path.join(options.uploadDir, ".auth")
      : undefined)

  applyEnv({
    UPLOAD_DIR: options.uploadDir,
    // Why not pass these two through: the old code treated "" as absent, and a
    // leftover empty INITIAL_ADMIN_PASSWORD would bootstrap a blank password.
    AUTH_DIR: authDir || undefined,
    USERS_FILE: undefined,
    SESSION_SECRET: undefined,
    INITIAL_ADMIN_PASSWORD: options.initialAdminPassword || undefined,
  })

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
    await writeUsersFile(authDir, options.seedUsers)
  }

  return createApp({
    uploadDir: options.uploadDir,
    authDir,
    initialAdminPassword: options.initialAdminPassword,
  })
}
