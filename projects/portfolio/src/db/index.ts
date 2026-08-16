import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolConfig } from 'pg'

export type DatabasePoolOptions = Pick<
  PoolConfig,
  'connectionTimeoutMillis' | 'query_timeout' | 'statement_timeout' | 'max'
>

export function getDatabase(databaseUrl: string, options: DatabasePoolOptions = {}) {
  return drizzle({
    connection: {
      connectionString: databaseUrl,
      ...options,
    },
  })
}
