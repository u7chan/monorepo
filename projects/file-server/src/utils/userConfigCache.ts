import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { UserConfig, UserRole } from "../types"
import { isValidUsername } from "./auth"

const USER_ROLES = new Set(["admin", "user"])

let cachedUsers: UserConfig[] | null = null
let cachedMtimeMs: number | null = null
let cachedPath: string | null = null

function toValidatedUsers(input: unknown): UserConfig[] {
  if (!Array.isArray(input)) {
    throw new Error("Users file must be an array of users.")
  }

  return input.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`Users file entry at index ${index} must be an object.`)
    }

    const { username, passwordHash, role, sessionVersion } = item as Record<string, unknown>

    if (typeof username !== "string" || !isValidUsername(username)) {
      throw new Error(`Users file entry at index ${index} has invalid username.`)
    }
    if (typeof passwordHash !== "string" || passwordHash.length === 0) {
      throw new Error(`Users file entry at index ${index} has invalid passwordHash.`)
    }
    if (typeof role !== "string" || !USER_ROLES.has(role)) {
      throw new Error(`Users file entry at index ${index} has invalid role.`)
    }

    return {
      username,
      passwordHash,
      role: role as UserRole,
      sessionVersion: typeof sessionVersion === "number" ? sessionVersion : 0,
    }
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

export async function saveUsersToFile(usersFile: string, users: UserConfig[]): Promise<void> {
  const dir = path.dirname(usersFile)
  await mkdir(dir, { recursive: true })
  const tmpFile = `${usersFile}.tmp`
  await writeFile(tmpFile, JSON.stringify(users, null, 2), "utf-8")
  await rename(tmpFile, usersFile)
  cachedUsers = null
  cachedPath = null
  cachedMtimeMs = null
}

export function resetUsersCacheForTests() {
  cachedUsers = null
  cachedPath = null
  cachedMtimeMs = null
}
