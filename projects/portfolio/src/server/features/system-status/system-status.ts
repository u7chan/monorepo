import { resolveFileServerBaseUrl } from '#/server/features/chat-conversations/file-server-client'
import { SYSTEM_STATUS_REASONS } from '#/types'
import type { PublicSystemCheck, PublicSystemStatus, SystemCheck, SystemStatus, SystemStatusReason } from '#/types'
import { checkDatabase } from './checks/database'
import { checkFileServerApi, checkFileServerHealth, checkFileServerPublic } from './checks/file-server'
import type { SystemStatusEnv } from './env'

const CACHE_TTL_MS = 5_000
const SYSTEM_STATUS_UNAVAILABLE_MESSAGE = 'System status unavailable'

type CachedStatus = {
  expiresAt: number
  value: SystemStatus
}

type NegativeCooldown = {
  expiresAt: number
}

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

function toPublicCheck(check: SystemCheck): PublicSystemCheck {
  return {
    status: check.status,
    reason: isSystemStatusReason(check.reason) ? check.reason : 'check-failed',
    checkedAt: check.checkedAt,
  }
}

export function toPublicSystemStatus(status: SystemStatus): PublicSystemStatus {
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
