import { randomBytes } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { isNodeErrorCode } from "./nodeError"

const SESSION_SECRET_FILENAME = "session-secret"

let cachedSessionSecret: string | null = null
let cachedSessionSecretPath: string | null = null
let cachedSessionSecretMtimeMs: number | null = null

export function getSessionSecretFilePath(authDir: string): string {
  return path.join(authDir, SESSION_SECRET_FILENAME)
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
    if (isNodeErrorCode(error, "ENOENT")) {
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
    if (!isNodeErrorCode(error, "EEXIST")) {
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
