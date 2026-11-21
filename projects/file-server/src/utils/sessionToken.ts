import { createHmac, timingSafeEqual } from "node:crypto"
import { isValidUsername } from "./auth"

export const SESSION_COOKIE_NAME = "session"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

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
