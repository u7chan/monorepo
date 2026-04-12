import { hashPassword } from '../../server/features/auth/password-hash'
import { parseAddUserArgs } from './add-user-args'
import { addUser } from './add-user-record'

async function main() {
  const databaseUrl = process.env.DATABASE_URL || ''

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const { email, password } = parseAddUserArgs(process.argv)
  const passwordHash = hashPassword(password)

  await addUser({ databaseUrl, email, passwordHash })

  console.log(`Auth user has been added for ${email}.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
