import { upsertUser } from './upsert-user'

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

  await upsertUser({ databaseUrl, email, passwordHash })

  console.log(`User auth seed has been upserted for ${email}.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
