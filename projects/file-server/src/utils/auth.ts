import { createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import type { UserConfig, UserState } from "../types"
import { loadUsersFromFileWithCache } from "./userConfigCache"

const USERNAME_PATTERN = /^[a-z0-9_-]+$/
export const SESSION_COOKIE_NAME = "session"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

export function validateAuthConfig(
  usersFile: string | undefined,
  sessionSecret: string | undefined,
): void {
  if (usersFile && !sessionSecret) {
    throw new Error(
      "[FATAL] SESSION_SECRET is required when USERS_FILE is set.",
    )
  }

  if (sessionSecret && sessionSecret.length < 32) {
    console.warn("[WARN] SESSION_SECRET should be at least 32 characters long.")
  }
}

export async function loadUsersConfig(
  usersFile: string | undefined,
): Promise<UserConfig[] | null> {
  if (!usersFile) {
    return null
  }

  return loadUsersFromFileWithCache(usersFile)
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
  return USERNAME_PATTERN.test(username)
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
  payload: { username: string },
  secret: string,
): Promise<string> {
  if (!isValidUsername(payload.username)) {
    throw new Error("Invalid username for session payload.")
  }

  const signature = signValue(payload.username, secret)
  return `${payload.username}:${signature}`
}

export async function verifySession(
  cookieValue: string,
  secret: string,
): Promise<{ username: string } | null> {
  const separatorIndex = cookieValue.indexOf(":")
  if (separatorIndex <= 0 || separatorIndex === cookieValue.length - 1) {
    return null
  }

  const username = cookieValue.slice(0, separatorIndex)
  const signature = cookieValue.slice(separatorIndex + 1)

  if (!isValidUsername(username)) {
    return null
  }

  const expectedSignature = signValue(username, secret)
  if (!safeStringEqual(signature, expectedSignature)) {
    return null
  }

  return { username }
}

export function getUserUploadDir(
  baseDir: string,
  userState: UserState,
): string {
  if (userState.type === "anonymous") {
    return baseDir
  }

  if (userState.role === "admin") {
    return baseDir
  }

  return path.join(baseDir, userState.username)
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
