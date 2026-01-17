import { getDatabase } from '#/db'
import { usersTable } from '#/db/schema'
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
  logout(email: string): Promise<void>
}

export const auth: Auth = {
  async login(databaseUrl: string, email: string, password: string): Promise<void> {
    const db = getDatabase(databaseUrl)
    const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
    const userExists = users.length > 0

    // TODO: DBを用いたパスワード認証に置き換える
    if (!userExists || password !== 'testexample') {
      throw new AuthenticationError('認証に失敗しました')
    }
  },

  async logout(_email: string): Promise<void> {
    // TODO
  },
}
