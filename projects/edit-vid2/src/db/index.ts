import { Database as BunDatabase } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'

export function getDatabase(path: string) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const sqlite = new BunDatabase(path, { create: true })
  sqlite.exec('PRAGMA journal_mode=WAL')
  sqlite.exec('PRAGMA foreign_keys=ON')
  return drizzle({ client: sqlite })
}

export type AppDatabase = ReturnType<typeof getDatabase>
