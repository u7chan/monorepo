import { getDatabase } from '#/db'
import { usersTable } from '#/db/schema'
import { verifyPassword } from '#/server/features/auth/password-hash'
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

export const auth: Auth = {
  async login(databaseUrl: string, email: string, password: string): Promise<void> {
    const db = getDatabase(databaseUrl)
    const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
    const user = users[0]

    if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw new AuthenticationError('認証に失敗しました')
    }
  },

  async logout(): Promise<void> {
    return Promise.resolve()
  },
}
