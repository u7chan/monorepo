import type { SystemCheck, SystemCheckStatus, SystemStatusReason } from '#/types'

const CHECK_TIMEOUT_MS = 3_000

export type CheckOutcome = Pick<SystemCheck, 'status' | 'reason'>

class CheckTimeoutError extends Error {}

export function outcome(status: SystemCheckStatus, reason: SystemStatusReason): CheckOutcome {
  return { status, reason }
}

export function okOutcome(): CheckOutcome {
  return outcome('ok', 'ok')
}

export function notConfiguredOutcome(): CheckOutcome {
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

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

function isConnectionError(error: unknown): boolean {
  let current: unknown = error

  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) {
      return false
    }

    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) {
      return true
    }

    // undici は接続・TLS の失敗を TypeError('fetch failed') に畳み、原因を cause に置く。
    // 認証失敗（HTTP status）と区別するため、cause の code も見る。
    if (current.message === 'fetch failed') {
      return true
    }

    current = (current as { cause?: unknown }).cause
  }

  return false
}

export function failedOutcome(error: unknown, fallbackReason: SystemStatusReason): CheckOutcome {
  if (isCheckTimeoutError(error)) {
    return outcome('error', 'timeout')
  }
  if (isConnectionError(error)) {
    return outcome('error', 'connection-failed')
  }
  return outcome('error', fallbackReason)
}

export function toCheck(value: CheckOutcome, checkedAt: string): SystemCheck {
  return { ...value, checkedAt }
}

export async function withCheckTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

export async function runCheck(
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

export function aggregateOutcome(children: CheckOutcome[], fallbackReason: SystemStatusReason): CheckOutcome {
  const failed = children.find((child) => child.status === 'error')
  if (failed) {
    return outcome('error', failed.reason || fallbackReason)
  }

  if (children.some((child) => child.status === 'not-configured')) {
    return notConfiguredOutcome()
  }

  return okOutcome()
}
