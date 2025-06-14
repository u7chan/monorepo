import { uuidv7 } from 'uuidv7'

import { getDatabase } from '../'
import { users } from '../schema'

const initialUsers = [
  {
    id: uuidv7(),
    email: 'test@example.com',
    createdAt: new Date(),
  },
]

async function main() {
  const db = getDatabase(process.env.DATABASE_URL || '')
  await db.insert(users).values(initialUsers)
  console.log('🚀 User initial data seeding has been completed successfully.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
