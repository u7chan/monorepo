import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { AppBindings, UserConfig, UserState } from "../types"

const USERNAME_PATTERN = /^[a-z0-9_-]+$/
const RESERVED_USERNAMES = new Set(["public", "private"])
const USERS_FILENAME = "users.json"
const SESSION_SECRET_FILENAME = "session-secret"
export const SESSION_COOKIE_NAME = "session"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7
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

let cachedSessionSecret: string | null = null
let cachedSessionSecretPath: string | null = null
let cachedSessionSecretMtimeMs: number | null = null

export function getUsersFilePath(authDir: string): string {
  return path.join(authDir, USERS_FILENAME)
}

export function getSessionSecretFilePath(authDir: string): string {
  return path.join(authDir, SESSION_SECRET_FILENAME)
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

function resetSessionSecretCache(): void {
  cachedSessionSecret = null
  cachedSessionSecretPath = null
  cachedSessionSecretMtimeMs = null
}

async function readSessionSecretIfPresent(
  sessionSecretFile: string,
): Promise<string | null> {
  try {
    const sessionSecret = (await readFile(sessionSecretFile, "utf-8")).trim()
    return sessionSecret || null
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    if (errno.code === "ENOENT") {
      return null
    }
    throw error
  }
}

export async function ensureSessionSecret(authDir: string): Promise<string> {
  await mkdir(authDir, { recursive: true })

  const sessionSecretFile = getSessionSecretFilePath(authDir)
  const existingSecret = await readSessionSecretIfPresent(sessionSecretFile)
  if (existingSecret) {
    return existingSecret
  }

  const sessionSecret = randomBytes(48).toString("base64url")
  try {
    // Use exclusive create so concurrent first startups converge on one secret.
    await writeFile(sessionSecretFile, `${sessionSecret}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    })
    resetSessionSecretCache()
    return sessionSecret
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    if (errno.code !== "EEXIST") {
      throw error
    }
  }

  const concurrentSecret = await readSessionSecretIfPresent(sessionSecretFile)
  if (!concurrentSecret) {
    throw new Error("session-secret file is empty.")
  }
  return concurrentSecret
}

export async function loadSessionSecretWithCache(
  authDir: string,
): Promise<string> {
  const sessionSecretFile = getSessionSecretFilePath(authDir)
  const fileStat = await stat(sessionSecretFile)

  if (
    cachedSessionSecret &&
    cachedSessionSecretPath === sessionSecretFile &&
    cachedSessionSecretMtimeMs === fileStat.mtimeMs
  ) {
    return cachedSessionSecret
  }

  const sessionSecret = (await readFile(sessionSecretFile, "utf-8")).trim()
  if (!sessionSecret) {
    throw new Error("session-secret file is empty.")
  }

  cachedSessionSecret = sessionSecret
  cachedSessionSecretPath = sessionSecretFile
  cachedSessionSecretMtimeMs = fileStat.mtimeMs

  return sessionSecret
}

export function resetSessionSecretCacheForTests(): void {
  resetSessionSecretCache()
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

function signValue(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

function safeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    return false
  }
  return timingSafeEqual(left, right)
}

export async function signSession(
  payload: { username: string; sessionVersion: number },
  secret: string,
): Promise<string> {
  if (!isValidUsername(payload.username)) {
    throw new Error("Invalid username for session payload.")
  }
  const data = `${payload.username}:${payload.sessionVersion}`
  const signature = signValue(data, secret)
  return `${data}:${signature}`
}

export async function verifySession(
  cookieValue: string,
  secret: string,
): Promise<{ username: string; sessionVersion: number } | null> {
  const lastColon = cookieValue.lastIndexOf(":")
  if (lastColon <= 0 || lastColon === cookieValue.length - 1) {
    return null
  }

  const data = cookieValue.slice(0, lastColon)
  const signature = cookieValue.slice(lastColon + 1)

  const firstColon = data.indexOf(":")
  if (firstColon <= 0) {
    return null
  }

  const username = data.slice(0, firstColon)
  const versionStr = data.slice(firstColon + 1)
  const sessionVersion = Number(versionStr)

  if (!isValidUsername(username)) {
    return null
  }
  if (!Number.isInteger(sessionVersion) || sessionVersion < 0) {
    return null
  }

  const expectedSignature = signValue(data, secret)
  if (!safeStringEqual(signature, expectedSignature)) {
    return null
  }

  return { username, sessionVersion }
}

export function getUserUploadDir(
  baseDir: string,
  userState: UserState,
): string {
  if (userState.type === "authenticated" && userState.role === "user") {
    return path.join(baseDir, "private", userState.username)
  }
  return baseDir
}

export function getUserHomeVirtualPath(userState: UserState): string | null {
  if (userState.type !== "authenticated" || userState.role !== "user") {
    return null
  }
  return `private/${userState.username}`
}

export function isUserHomeVirtualPath(
  userState: UserState,
  virtualPath: string,
): boolean {
  const homePath = getUserHomeVirtualPath(userState)
  if (!homePath) {
    return false
  }
  return (
    virtualPath === "" || virtualPath === "private" || virtualPath === homePath
  )
}

export function toBrowseLocation(
  userState: UserState,
  virtualPath: string,
): string {
  return isUserHomeVirtualPath(userState, virtualPath) ? "" : virtualPath
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
