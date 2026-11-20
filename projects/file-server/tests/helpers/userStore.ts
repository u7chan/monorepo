import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { getUsersFilePath } from "../../src/utils/auth"
import { resetUsersCacheForTests } from "../../src/utils/userConfigCache"

export type PlainUser = {
  username: string
  password: string
  role?: "admin" | "user"
}

/**
 * Why: every test file that exercises authentication seeded users.json with
 * the same bcrypt work factor and cache reset, so a lower cost would silently
 * not reach one of the copies.
 */
export async function writeUsersFile(
  authDir: string,
  users: PlainUser[],
): Promise<void> {
  const usersFile = getUsersFilePath(authDir)
  const userConfigs = await Promise.all(
    users.map(async (user) => ({
      username: user.username,
      passwordHash: await Bun.password.hash(user.password, {
        algorithm: "bcrypt",
        cost: 4,
      }),
      role: user.role ?? "user",
      sessionVersion: 0,
    })),
  )
  await mkdir(path.dirname(usersFile), { recursive: true })
  await writeFile(usersFile, JSON.stringify(userConfigs), "utf-8")
  resetUsersCacheForTests()
}
