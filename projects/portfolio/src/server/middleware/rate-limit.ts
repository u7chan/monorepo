import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { AuthenticationError } from '#/server/features/auth/auth'
import type { HonoEnv } from '#/server/routes/shared'

type RateLimitEntry = {
  failures: number
  firstFailureAt: number
  blockedUntil: number
}

const store = new Map<string, RateLimitEntry>()

const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 60_000
const BLOCK_DURATION_MS = 60_000
const CLEANUP_INTERVAL_MS = 60_000

const isUnrefableTimer = (
  timer: ReturnType<typeof setInterval>
): timer is ReturnType<typeof setInterval> & { unref(): void } => {
  return typeof timer === 'object' && timer !== null && 'unref' in timer
}

const getClientIp = (c: Context<HonoEnv>) => {
  return getConnInfo(c).remote.address ?? 'unknown'
}

const isBlocked = (entry: RateLimitEntry | undefined, now: number) => {
  return entry !== undefined && now < entry.blockedUntil
}

const recordFailure = (ip: string, now: number) => {
  const current = store.get(ip)
  const entry =
    current && current.blockedUntil === 0 && now - current.firstFailureAt < FAILURE_WINDOW_MS
      ? current
      : {
          failures: 0,
          firstFailureAt: now,
          blockedUntil: 0,
        }

  entry.failures += 1
  if (entry.failures >= MAX_FAILURES) {
    entry.blockedUntil = now + BLOCK_DURATION_MS
  }

  store.set(ip, entry)
}

const resetFailures = (ip: string) => {
  store.delete(ip)
}

const cleanupExpiredEntries = () => {
  const now = Date.now()

  for (const [ip, entry] of store) {
    const blockExpired = entry.blockedUntil > 0 && now >= entry.blockedUntil
    const failureWindowExpired = entry.blockedUntil === 0 && now - entry.firstFailureAt > FAILURE_WINDOW_MS

    if (blockExpired || failureWindowExpired) {
      store.delete(ip)
    }
  }
}

const cleanupInterval = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS)
if (isUnrefableTimer(cleanupInterval)) {
  cleanupInterval.unref()
}

export const resetSigninRateLimit = () => {
  store.clear()
}

export const signinRateLimit = createMiddleware<HonoEnv>(async (c, next) => {
  const ip = getClientIp(c)
  const now = Date.now()
  const entry = store.get(ip)

  if (isBlocked(entry, now)) {
    return c.json({ error: 'Too many login attempts. Please try again later.' }, 429)
  }

  try {
    await next()
  } catch (error) {
    if (error instanceof AuthenticationError) {
      recordFailure(ip, Date.now())
    }
    throw error
  }

  if (c.res.status === 401) {
    recordFailure(ip, Date.now())
    return
  }

  resetFailures(ip)
})
