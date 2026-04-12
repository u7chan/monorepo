import { getDatabase } from '#/db'
import { usersTable } from '#/db/schema'
import { hashPassword, verifyPassword } from '#/server/features/auth/password-hash'
import { eq } from 'drizzle-orm'

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
    Object.setPrototypeOf(this, AuthenticationError.prototype)
  }
}

interface Auth {
  login(databaseUrl: string, email: string, password: string): Promise<void>
  logout(): Promise<void>
}

const DUMMY_PASSWORD_HASH = hashPassword('dummy-password-for-timing-padding')

export const auth: Auth = {
  async login(databaseUrl: string, email: string, password: string): Promise<void> {
    const db = getDatabase(databaseUrl)
    const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
    const user = users[0]
    const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH
    const passwordMatched = verifyPassword(password, passwordHash)

    if (!user?.passwordHash || !passwordMatched) {
      throw new AuthenticationError('認証に失敗しました')
    }
  },

  async logout(): Promise<void> {
    return Promise.resolve()
  },
}
