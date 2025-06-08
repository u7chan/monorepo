import { drizzle } from 'drizzle-orm/node-postgres'

export function getDatabase(databaseUrl: string) {
  const db = drizzle(databaseUrl)
  return db
}
