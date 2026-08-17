import { sql } from 'drizzle-orm'
import { getDatabase } from '#/db'
import {
  loginToFileServer,
  readFileServerApi,
  resolveFileServerBaseUrl,
  resolveFileServerPublicBaseUrl,
  type FileServerConfig,
} from '#/server/features/chat-conversations/file-server-client'
import type { Env } from '#/server/routes/shared'
import { SYSTEM_STATUS_REASONS } from '#/types'
import type {
  DatabaseSystemStatus,
  FileServerApiSystemStatus,
  SystemCheck,
  SystemCheckStatus,
  SystemStatus,
  SystemStatusReason,
} from '#/types'

const CHECK_TIMEOUT_MS = 3_000
const DATABASE_QUERY_TIMEOUT_MS = 2_500
const CACHE_TTL_MS = 5_000
const SYSTEM_STATUS_UNAVAILABLE_MESSAGE = 'System status unavailable'

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

type NegativeCooldown = {
  expiresAt: number
}

class CheckTimeoutError extends Error {}

class SystemStatusUnavailableError extends Error {
  constructor() {
    super(SYSTEM_STATUS_UNAVAILABLE_MESSAGE)
    this.name = 'SystemStatusUnavailableError'
  }
}

const statusCache = new Map<string, CachedStatus>()
const negativeCooldowns = new Map<string, NegativeCooldown>()
const inFlightChecks = new Map<string, Promise<SystemStatus>>()
let cacheGeneration = 0

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

function outcome(status: SystemCheckStatus, reason: SystemStatusReason): CheckOutcome {
  return { status, reason }
}

function okOutcome(): CheckOutcome {
  return outcome('ok', 'ok')
}

function notConfiguredOutcome(): CheckOutcome {
  return outcome('not-configured', 'not-configured')
}

function isCheckTimeoutError(error: unknown): boolean {
  if (error instanceof CheckTimeoutError) {
    return true
  }

  return (
    error instanceof Error &&
    /^(?:Query read timeout|timeout exceeded when trying to connect|Connection terminated due to connection timeout)/i.test(
      error.message
    )
  )
}

function failedOutcome(error: unknown, fallbackReason: SystemStatusReason): CheckOutcome {
  return outcome('error', isCheckTimeoutError(error) ? 'timeout' : fallbackReason)
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
  fallbackReason: SystemStatusReason
): Promise<CheckOutcome> {
  try {
    await withCheckTimeout(operation)
    return okOutcome()
  } catch (error) {
    return failedOutcome(error, fallbackReason)
  }
}

function aggregateOutcome(children: CheckOutcome[], fallbackReason: SystemStatusReason): CheckOutcome {
  const failed = children.find((child) => child.status === 'error')
  if (failed) {
    return outcome('error', failed.reason || fallbackReason)
  }

  if (children.some((child) => child.status === 'not-configured')) {
    return notConfiguredOutcome()
  }

  return okOutcome()
}

async function closeDatabase(database: ReturnType<typeof getDatabase>): Promise<void> {
  const client = (database as unknown as { $client?: { end?: () => Promise<void> } }).$client
  if (typeof client?.end === 'function') {
    await client.end()
  }
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
    const response = await fetch(`${publicBaseUrl}/healthz`, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal,
    })

    if (!response.ok || response.status !== 200) {
      throw new Error(`file-server public healthz returned ${response.status}`)
    }

    const payload = (await response.json().catch(() => null)) as { status?: unknown } | null
    if (!payload || payload.status !== 'ok') {
      throw new Error('file-server public healthz returned an invalid response')
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

function isSystemStatusReason(value: unknown): value is SystemStatusReason {
  return typeof value === 'string' && (SYSTEM_STATUS_REASONS as readonly string[]).includes(value)
}

function toPublicCheck(check: SystemCheck): SystemCheck {
  return {
    status: check.status,
    reason: isSystemStatusReason(check.reason) ? check.reason : 'check-failed',
    checkedAt: check.checkedAt,
  }
}

export function toPublicSystemStatus(status: SystemStatus): SystemStatus {
  const database = status.checks.database
  const fileServerApi = status.checks.fileServerApi

  return {
    status: status.status,
    checkedAt: status.checkedAt,
    checks: {
      database: {
        ...toPublicCheck(database),
        connection: toPublicCheck(database.connection),
        schema: toPublicCheck(database.schema),
      },
      fileServerHealth: toPublicCheck(status.checks.fileServerHealth),
      fileServerApi: {
        ...toPublicCheck(fileServerApi),
        login: toPublicCheck(fileServerApi.login),
        read: toPublicCheck(fileServerApi.read),
      },
      fileServerPublic: toPublicCheck(status.checks.fileServerPublic),
    },
  }
}

export async function getSystemStatus(env: SystemStatusEnv): Promise<SystemStatus> {
  const key = buildCacheKey(env)
  const pending = inFlightChecks.get(key)
  if (pending) {
    return pending
  }

  const now = Date.now()
  const cached = statusCache.get(key)
  if (cached) {
    if (now < cached.expiresAt) {
      return cached.value
    }
    statusCache.delete(key)
  }

  const negativeCooldown = negativeCooldowns.get(key)
  if (negativeCooldown) {
    if (now < negativeCooldown.expiresAt) {
      throw new SystemStatusUnavailableError()
    }
    negativeCooldowns.delete(key)
  }

  const generation = cacheGeneration
  let resolvePending!: (value: SystemStatus | PromiseLike<SystemStatus>) => void
  let rejectPending!: (reason?: unknown) => void
  const pendingCheck = new Promise<SystemStatus>((resolve, reject) => {
    resolvePending = resolve
    rejectPending = reject
  })
  inFlightChecks.set(key, pendingCheck)

  const check = runSystemStatus(env)
  void check
    .then(
      (value) => {
        const completedAt = Date.now()
        if (cacheGeneration === generation) {
          statusCache.set(key, { expiresAt: completedAt + CACHE_TTL_MS, value })
          negativeCooldowns.delete(key)
        }
        resolvePending(value)
      },
      () => {
        const completedAt = Date.now()
        if (cacheGeneration === generation) {
          statusCache.delete(key)
          negativeCooldowns.set(key, { expiresAt: completedAt + CACHE_TTL_MS })
        }
        rejectPending(new SystemStatusUnavailableError())
      }
    )
    .finally(() => {
      if (inFlightChecks.get(key) === pendingCheck) {
        inFlightChecks.delete(key)
      }
    })

  return pendingCheck
}

export function resetSystemStatusCacheForTests(): void {
  cacheGeneration += 1
  statusCache.clear()
  negativeCooldowns.clear()
  inFlightChecks.clear()
}
