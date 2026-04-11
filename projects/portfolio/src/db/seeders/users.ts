import { uuidv7 } from 'uuidv7'
import { getDatabase } from '../'
import { usersTable } from '../schema'

async function main() {
  const databaseUrl = process.env.DATABASE_URL || ''
  const email = process.env.AUTH_SEED_EMAIL || ''
  const passwordHash = process.env.AUTH_SEED_PASSWORD_HASH || ''

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  if (!email || !passwordHash) {
    throw new Error('AUTH_SEED_EMAIL and AUTH_SEED_PASSWORD_HASH are required')
  }

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

  console.log(`User auth seed has been upserted for ${email}.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
