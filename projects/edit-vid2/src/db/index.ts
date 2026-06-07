import type { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database as BunDatabase } from 'bun:sqlite'

export function getDatabase(path: string) {
  const sqlite = new BunDatabase(path, { create: true })
  sqlite.exec('PRAGMA journal_mode=WAL')
  sqlite.exec('PRAGMA foreign_keys=ON')
  return drizzle({ client: sqlite })
}

export type AppDatabase = ReturnType<typeof getDatabase>
