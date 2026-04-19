import { readFile, stat } from "node:fs/promises"
import { getUsersFilePath, MASTER_ADMIN_USERNAME } from "./auth"
import { loadUsersFromFileWithCache, saveUsersToFile } from "./userConfigCache"

export async function bootstrapAdminUser(
  authDir: string,
  initialAdminPassword?: string,
): Promise<void> {
  const usersFile = getUsersFilePath(authDir)

  let fileExists = false
  try {
    await stat(usersFile)
    fileExists = true
  } catch {
    // File doesn't exist
  }

  if (fileExists) {
    const raw = await readFile(usersFile, "utf-8")

    if (raw.trim() !== "") {
      // Non-empty file: parse and validate strictly — errors are startup failures
      const users = await loadUsersFromFileWithCache(usersFile)

      if (users.length > 0) {
        const admin = users.find((u) => u.username === MASTER_ADMIN_USERNAME)
        if (!admin) {
          throw new Error(
            `[FATAL] Users file is non-empty but missing '${MASTER_ADMIN_USERNAME}' user.`,
          )
        }
        if (admin.role !== "admin") {
          throw new Error(
            `[FATAL] '${MASTER_ADMIN_USERNAME}' user must have role 'admin'.`,
          )
        }
        if (initialAdminPassword) {
          console.log(
            "[BOOTSTRAP] INITIAL_ADMIN_PASSWORD is ignored because users.json already contains a valid admin user.",
          )
        }
        return
      }
      // Valid JSON empty array — fall through to bootstrap
    }
    // Empty file (0 bytes or whitespace) — fall through to bootstrap
  }

  const password = initialAdminPassword ?? generateRandomPassword()
  const passwordHash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 12,
  })

  await saveUsersToFile(usersFile, [
    {
      username: MASTER_ADMIN_USERNAME,
      passwordHash,
      role: "admin",
      sessionVersion: 0,
    },
  ])

  if (!initialAdminPassword) {
    console.log(`[BOOTSTRAP] Initial admin password: ${password}`)
    console.log("[BOOTSTRAP] Change this password after your first login.")
  }
}

function generateRandomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => chars[b % chars.length]).join("")
}
