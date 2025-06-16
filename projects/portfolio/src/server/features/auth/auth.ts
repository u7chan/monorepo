import { eq } from 'drizzle-orm'

import { getDatabase } from '#/db'
import { usersTable } from '#/db/schema'

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
    Object.setPrototypeOf(this, AuthenticationError.prototype)
  }
}

interface Auth {
  login(databaseUrl: string, email: string, password: string): Promise<void>
  logout(email: string): Promise<void>
}

export const auth: Auth = {
  async login(databaseUrl: string, email: string, password: string): Promise<void> {
    const db = getDatabase(databaseUrl)
    const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
    const userExists = users.length > 0

    if (!userExists || password !== 'test') {
      throw new AuthenticationError('認証に失敗しました')
    }
  },

  async logout(email: string): Promise<void> {
    // TODO
  },
}
