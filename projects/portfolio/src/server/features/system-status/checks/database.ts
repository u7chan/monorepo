import { sql } from 'drizzle-orm'
import { getDatabase } from '#/db'
import type { DatabaseSystemStatus } from '#/types'
import { aggregateOutcome, notConfiguredOutcome, outcome, runCheck, toCheck } from './check-outcome'

const DATABASE_QUERY_TIMEOUT_MS = 2_500

const databasePoolOptions = {
  connectionTimeoutMillis: DATABASE_QUERY_TIMEOUT_MS,
  query_timeout: DATABASE_QUERY_TIMEOUT_MS,
  statement_timeout: DATABASE_QUERY_TIMEOUT_MS,
  max: 2,
} as const

const requiredSchema = {
  users: ['id', 'email', 'password_hash', 'created_at'],
  conversations: ['id', 'user_id', 'title', 'created_at', 'updated_at'],
  messages: ['id', 'conversation_id', 'role', 'content', 'reasoning_content', 'metadata', 'created_at'],
  prompt_templates: [
    'id',
    'input_type',
    'title',
    'placeholder',
    'prompt',
    'display_order',
    'enabled',
    'created_at',
    'updated_at',
  ],
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord)
  }

  if (isRecord(value) && Array.isArray(value.rows)) {
    return value.rows.filter(isRecord)
  }

  return []
}

async function closeDatabase(database: ReturnType<typeof getDatabase>): Promise<void> {
  const client = (database as unknown as { $client?: { end?: () => Promise<void> } }).$client
  if (typeof client?.end === 'function') {
    await client.end()
  }
}

export async function checkDatabase(databaseUrl: string | undefined, checkedAt: string): Promise<DatabaseSystemStatus> {
  if (!databaseUrl?.trim()) {
    const connection = toCheck(notConfiguredOutcome(), checkedAt)
    const schema = toCheck(notConfiguredOutcome(), checkedAt)
    return {
      ...toCheck(notConfiguredOutcome(), checkedAt),
      connection,
      schema,
    }
  }

  let database: ReturnType<typeof getDatabase>
  try {
    database = getDatabase(databaseUrl, databasePoolOptions)
  } catch {
    const connection = toCheck(outcome('error', 'connection-failed'), checkedAt)
    const schema = toCheck(outcome('error', 'schema-check-failed'), checkedAt)
    return {
      ...toCheck(outcome('error', 'connection-failed'), checkedAt),
      connection,
      schema,
    }
  }

  try {
    const [connectionOutcome, schemaOutcome] = await Promise.all([
      runCheck(async () => {
        await database.execute(sql`SELECT 1`)
      }, 'connection-failed'),
      runCheck(async () => {
        const result = await database.execute(sql`
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
        `)
        const columns = new Map<string, Set<string>>()

        for (const row of getRows(result)) {
          const tableName = typeof row.table_name === 'string' ? row.table_name : null
          const columnName = typeof row.column_name === 'string' ? row.column_name : null
          if (!tableName || !columnName) {
            continue
          }

          const tableColumns = columns.get(tableName) ?? new Set<string>()
          tableColumns.add(columnName)
          columns.set(tableName, tableColumns)
        }

        const schemaIsComplete = Object.entries(requiredSchema).every(([tableName, requiredColumns]) => {
          const tableColumns = columns.get(tableName)
          return tableColumns && requiredColumns.every((columnName) => tableColumns.has(columnName))
        })

        if (!schemaIsComplete) {
          throw new Error('database schema is incomplete')
        }
      }, 'schema-check-failed'),
    ])

    const connection = toCheck(connectionOutcome, checkedAt)
    const schema = toCheck(schemaOutcome, checkedAt)
    return {
      ...toCheck(aggregateOutcome([connectionOutcome, schemaOutcome], 'database-unavailable'), checkedAt),
      connection,
      schema,
    }
  } finally {
    await closeDatabase(database).catch(() => undefined)
  }
}
