import { sql } from 'drizzle-orm'
import { getDatabase } from '#/db'
import {
  checkFileExists,
  loginToFileServer,
  readFileServerApi,
  resolveFileServerBaseUrl,
  resolveFileServerPublicBaseUrl,
  type FileServerConfig,
} from '#/server/features/chat-conversations/file-server-client'
import type { Env } from '#/server/routes/shared'
import type {
  DatabaseSystemStatus,
  FileServerApiSystemStatus,
  SystemCheck,
  SystemCheckStatus,
  SystemStatus,
} from '#/types'

const CHECK_TIMEOUT_MS = 3_000
const CACHE_TTL_MS = 5_000

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

type CheckOutcome = Pick<SystemCheck, 'status' | 'reason'>
type SystemStatusEnv = Pick<
  Env,
  | 'DATABASE_URL'
  | 'FILE_SERVER_URL'
  | 'FILE_SERVER_PUBLIC_URL'
  | 'FILE_SERVER_ADMIN_USERNAME'
  | 'FILE_SERVER_ADMIN_PASSWORD'
>

type CachedStatus = {
  expiresAt: number
  value: SystemStatus
}

class CheckTimeoutError extends Error {}

const statusCache = new Map<string, CachedStatus>()
const inFlightChecks = new Map<string, Promise<SystemStatus>>()

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

function outcome(status: SystemCheckStatus, reason: string): CheckOutcome {
  return { status, reason }
}

function okOutcome(): CheckOutcome {
  return outcome('ok', 'ok')
}

function notConfiguredOutcome(): CheckOutcome {
  return outcome('not-configured', 'not-configured')
}

function failedOutcome(error: unknown, fallbackReason: string): CheckOutcome {
  return outcome('error', error instanceof CheckTimeoutError ? 'timeout' : fallbackReason)
}

function toCheck(value: CheckOutcome, checkedAt: string): SystemCheck {
  return { ...value, checkedAt }
}

async function withCheckTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject(new CheckTimeoutError('system status check timed out'))
    }, CHECK_TIMEOUT_MS)
  })

  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

async function runCheck(
  operation: (signal: AbortSignal) => Promise<void>,
  fallbackReason: string
): Promise<CheckOutcome> {
  try {
    await withCheckTimeout(operation)
    return okOutcome()
  } catch (error) {
    return failedOutcome(error, fallbackReason)
  }
}

function aggregateOutcome(children: CheckOutcome[], fallbackReason: string): CheckOutcome {
  const failed = children.find((child) => child.status === 'error')
  if (failed) {
    return outcome('error', failed.reason || fallbackReason)
  }

  if (children.some((child) => child.status === 'not-configured')) {
    return notConfiguredOutcome()
  }

  return okOutcome()
}

async function checkDatabase(databaseUrl: string | undefined, checkedAt: string): Promise<DatabaseSystemStatus> {
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
    database = getDatabase(databaseUrl)
  } catch {
    const connection = toCheck(outcome('error', 'connection-failed'), checkedAt)
    const schema = toCheck(outcome('error', 'schema-check-failed'), checkedAt)
    return {
      ...toCheck(outcome('error', 'connection-failed'), checkedAt),
      connection,
      schema,
    }
  }

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
}

function resolveFileServerApiConfig(env: SystemStatusEnv): FileServerConfig | null {
  const baseUrl = resolveFileServerBaseUrl(env)
  const username = (env.FILE_SERVER_ADMIN_USERNAME ?? '').trim()
  const password = env.FILE_SERVER_ADMIN_PASSWORD ?? ''

  if (!baseUrl || !username || !password) {
    return null
  }

  return {
    baseUrl,
    publicBaseUrl: resolveFileServerPublicBaseUrl(env) ?? '',
    credentials: { username, password },
  }
}

async function checkFileServerHealth(baseUrl: string | null, checkedAt: string): Promise<SystemCheck> {
  if (!baseUrl) {
    return toCheck(notConfiguredOutcome(), checkedAt)
  }

  const result = await runCheck(async (signal) => {
    const response = await fetch(`${baseUrl}/healthz`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    })

    if (!response.ok) {
      throw new Error(`file-server healthz returned ${response.status}`)
    }
  }, 'healthz-unavailable')

  return toCheck(result, checkedAt)
}

async function checkFileServerApi(env: SystemStatusEnv, checkedAt: string): Promise<FileServerApiSystemStatus> {
  const config = resolveFileServerApiConfig(env)
  if (!config) {
    const login = toCheck(notConfiguredOutcome(), checkedAt)
    const read = toCheck(notConfiguredOutcome(), checkedAt)
    return {
      ...toCheck(notConfiguredOutcome(), checkedAt),
      login,
      read,
    }
  }

  let phase: 'login' | 'read' = 'login'
  let loginOutcome: CheckOutcome = outcome('error', 'login-failed')
  let readOutcome: CheckOutcome = outcome('error', 'login-failed')

  try {
    await withCheckTimeout(async (signal) => {
      const session = await loginToFileServer(config, { signal })
      loginOutcome = okOutcome()
      phase = 'read'
      await readFileServerApi(config, session, { signal })
    })
    readOutcome = okOutcome()
  } catch (error) {
    const reason = error instanceof CheckTimeoutError ? 'timeout' : phase === 'login' ? 'login-failed' : 'read-failed'
    if (phase === 'login') {
      loginOutcome = outcome('error', reason)
      readOutcome = outcome('error', reason === 'timeout' ? 'timeout' : 'login-failed')
    } else {
      readOutcome = outcome('error', reason)
    }
  }

  const login = toCheck(loginOutcome, checkedAt)
  const read = toCheck(readOutcome, checkedAt)
  return {
    ...toCheck(aggregateOutcome([loginOutcome, readOutcome], 'file-server-api-unavailable'), checkedAt),
    login,
    read,
  }
}

async function checkFileServerPublic(env: SystemStatusEnv, checkedAt: string): Promise<SystemCheck> {
  const publicBaseUrl = resolveFileServerPublicBaseUrl(env)
  if (!publicBaseUrl) {
    return toCheck(notConfiguredOutcome(), checkedAt)
  }

  const result = await runCheck(async (signal) => {
    const exists = await checkFileExists(publicBaseUrl, '/', { signal })
    if (!exists) {
      throw new Error('file-server public endpoint is unavailable')
    }
  }, 'public-unavailable')

  return toCheck(result, checkedAt)
}

async function runSystemStatus(env: SystemStatusEnv): Promise<SystemStatus> {
  const checkedAt = new Date().toISOString()
  const [database, fileServerHealth, fileServerApi, fileServerPublic] = await Promise.all([
    checkDatabase(env.DATABASE_URL, checkedAt),
    checkFileServerHealth(resolveFileServerBaseUrl(env), checkedAt),
    checkFileServerApi(env, checkedAt),
    checkFileServerPublic(env, checkedAt),
  ])

  const checks = { database, fileServerHealth, fileServerApi, fileServerPublic }
  const status = Object.values(checks).every((check) => check.status === 'ok') ? 'ok' : 'degraded'

  return {
    status,
    checkedAt,
    checks,
  }
}

function buildCacheKey(env: SystemStatusEnv): string {
  return [
    env.DATABASE_URL ?? '',
    env.FILE_SERVER_URL ?? '',
    env.FILE_SERVER_PUBLIC_URL ?? '',
    env.FILE_SERVER_ADMIN_USERNAME ?? '',
    env.FILE_SERVER_ADMIN_PASSWORD ?? '',
  ].join('\u0000')
}

export async function getSystemStatus(env: SystemStatusEnv, options: { force?: boolean } = {}): Promise<SystemStatus> {
  const key = buildCacheKey(env)
  const pending = inFlightChecks.get(key)
  if (pending) {
    return pending
  }

  const cached = statusCache.get(key)
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const check = runSystemStatus(env)
  inFlightChecks.set(key, check)

  try {
    const value = await check
    statusCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value })
    return value
  } finally {
    inFlightChecks.delete(key)
  }
}

export function resetSystemStatusCacheForTests(): void {
  statusCache.clear()
  inFlightChecks.clear()
}
