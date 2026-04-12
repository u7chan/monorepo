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

function isDuplicateUserEmailError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  return 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'users_email_unique'
}

export async function addUser({ databaseUrl, email, passwordHash }: AddUserInput) {
  const db = getDatabase(databaseUrl)
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))

  if (users[0]) {
    throw new UserAlreadyExistsError(email)
  }

  try {
    await db.insert(usersTable).values({
      id: uuidv7(),
      email,
      passwordHash,
      createdAt: new Date(),
    })
  } catch (error) {
    if (isDuplicateUserEmailError(error)) {
      throw new UserAlreadyExistsError(email)
    }

    throw error
  }
}
