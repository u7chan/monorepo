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
 * Why not keep a copy of this seeding in each test file: every copy has to
 * repeat the bcrypt work factor and the cache reset, and lowering the cost for
 * a faster suite would only reach the copies someone remembered to edit.
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
