import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { getDatabase } from '../'
import { usersTable } from '../schema'

export interface AddUserInput {
  databaseUrl: string
  email: string
  passwordHash: string
}

export class UserAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`同じメールアドレスのユーザーは既に存在します: ${email}`)
    this.name = 'UserAlreadyExistsError'
    Object.setPrototypeOf(this, UserAlreadyExistsError.prototype)
  }
}

export async function addUser({ databaseUrl, email, passwordHash }: AddUserInput) {
  const db = getDatabase(databaseUrl)
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))

  if (users[0]) {
    throw new UserAlreadyExistsError(email)
  }

  await db.insert(usersTable).values({
    id: uuidv7(),
    email,
    passwordHash,
    createdAt: new Date(),
  })
}
