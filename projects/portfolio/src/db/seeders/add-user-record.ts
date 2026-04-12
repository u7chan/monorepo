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

async function hasUserWithEmail(db: ReturnType<typeof getDatabase>, email: string) {
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))

  return Boolean(users[0])
}

export async function ensureUserDoesNotExist(databaseUrl: string, email: string) {
  const db = getDatabase(databaseUrl)

  if (await hasUserWithEmail(db, email)) {
    throw new UserAlreadyExistsError(email)
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

  if (await hasUserWithEmail(db, email)) {
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
