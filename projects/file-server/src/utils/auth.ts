import path from "node:path"
import type { AppBindings, UserConfig } from "../types"

const USERNAME_PATTERN = /^[a-z0-9_-]+$/
const RESERVED_USERNAMES = new Set(["public", "private"])
const USERS_FILENAME = "users.json"
export const DEFAULT_UPLOAD_DIR = "./tmp"
export const MASTER_ADMIN_USERNAME = "admin"

export type AuthEnv = {
  AUTH_DIR?: string
  SESSION_SECRET?: string
  USERS_FILE?: string
}

export type RuntimeAuthEnv = AppBindings["Bindings"] &
  Pick<AuthEnv, "SESSION_SECRET" | "USERS_FILE">

export type ResolvedAuthConfig = {
  enabled: boolean
  authDir: string | null
  usersFile: string | null
}

export function getUsersFilePath(authDir: string): string {
  return path.join(authDir, USERS_FILENAME)
}

function normalizeOptionalPath(
  value: string | undefined | null,
): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

export function validateLegacyAuthEnv(
  env: Pick<AuthEnv, "SESSION_SECRET" | "USERS_FILE">,
): void {
  if (env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET has been removed. Use AUTH_DIR instead.")
  }
  if (env.USERS_FILE) {
    throw new Error("USERS_FILE has been removed. Use AUTH_DIR instead.")
  }
}

export function resolveAuthConfig(
  env: Pick<AuthEnv, "AUTH_DIR">,
): ResolvedAuthConfig {
  const authDir = normalizeOptionalPath(env.AUTH_DIR)

  return {
    enabled: authDir !== null,
    authDir,
    usersFile: authDir ? getUsersFilePath(authDir) : null,
  }
}

export function findUser(
  users: UserConfig[] | null,
  username: string,
): UserConfig | null {
  if (!users) {
    return null
  }
  return users.find((user) => user.username === username) ?? null
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username) && !RESERVED_USERNAMES.has(username)
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 })
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}

export function normalizeReturnTo(value: string | null | undefined): string {
  if (!value) {
    return "/"
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/"
  }
  return value
}
