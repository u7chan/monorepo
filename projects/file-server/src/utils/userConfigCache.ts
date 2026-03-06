import { readFile, stat } from "node:fs/promises"
import type { UserConfig } from "../types"

const USERNAME_PATTERN = /^[a-z0-9_-]+$/

let cachedUsers: UserConfig[] | null = null
let cachedMtimeMs: number | null = null
let cachedPath: string | null = null

function toValidatedUsers(input: unknown): UserConfig[] {
  if (!Array.isArray(input)) {
    throw new Error("USERS_FILE must be an array of users.")
  }

  return input.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`USERS_FILE entry at index ${index} must be an object.`)
    }

    const username = (item as { username?: unknown }).username
    const passwordHash = (item as { passwordHash?: unknown }).passwordHash

    if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
      throw new Error(
        `USERS_FILE entry at index ${index} has invalid username.`,
      )
    }
    if (typeof passwordHash !== "string" || passwordHash.length === 0) {
      throw new Error(
        `USERS_FILE entry at index ${index} has invalid passwordHash.`,
      )
    }

    return { username, passwordHash }
  })
}

export async function loadUsersFromFileWithCache(
  usersFile: string,
): Promise<UserConfig[]> {
  const fileStat = await stat(usersFile)

  if (
    cachedUsers &&
    cachedPath === usersFile &&
    cachedMtimeMs === fileStat.mtimeMs
  ) {
    return cachedUsers
  }

  const content = await readFile(usersFile, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error("USERS_FILE is not valid JSON.")
  }

  const users = toValidatedUsers(parsed)

  cachedUsers = users
  cachedPath = usersFile
  cachedMtimeMs = fileStat.mtimeMs

  return users
}

export function resetUsersCacheForTests() {
  cachedUsers = null
  cachedPath = null
  cachedMtimeMs = null
}
