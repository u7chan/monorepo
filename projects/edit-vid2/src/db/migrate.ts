import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { getDatabase } from '#/db'

const dbPath = process.env.DATABASE_URL ?? 'data/edit-vid2.db'
const db = getDatabase(dbPath)

migrate(db, { migrationsFolder: './drizzle' })
db.$client.close()

console.log(`migrated ${dbPath}`)
