import { uuidv7 } from 'uuidv7'
import { getDatabase } from '../'
import { usersTable } from '../schema'

export interface UpsertUserInput {
  databaseUrl: string
  email: string
  passwordHash: string
}

export async function upsertUser({ databaseUrl, email, passwordHash }: UpsertUserInput) {
  const db = getDatabase(databaseUrl)

  await db
    .insert(usersTable)
    .values({
      id: uuidv7(),
      email,
      passwordHash,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: usersTable.email,
      set: {
        passwordHash,
      },
    })
}
