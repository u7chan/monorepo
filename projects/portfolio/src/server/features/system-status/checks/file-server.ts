import {
  loginToFileServer,
  readFileServerApi,
  readJsonOrNull,
  resolveFileServerBaseUrl,
  resolveFileServerPublicBaseUrl,
  type FileServerConfig,
} from '#/server/features/chat-conversations/file-server-client'
import type { FileServerApiSystemStatus, SystemCheck } from '#/types'
import type { SystemStatusEnv } from '../env'
import {
  aggregateOutcome,
  failedOutcome,
  notConfiguredOutcome,
  okOutcome,
  outcome,
  runCheck,
  toCheck,
  withCheckTimeout,
  type CheckOutcome,
} from './check-outcome'

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

export async function checkFileServerHealth(baseUrl: string | null, checkedAt: string): Promise<SystemCheck> {
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

export async function checkFileServerApi(env: SystemStatusEnv, checkedAt: string): Promise<FileServerApiSystemStatus> {
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
    const failed = failedOutcome(error, phase === 'login' ? 'login-failed' : 'read-failed')
    if (phase === 'login') {
      loginOutcome = failed
      readOutcome = outcome('error', failed.reason)
    } else {
      readOutcome = failed
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

export async function checkFileServerPublic(env: SystemStatusEnv, checkedAt: string): Promise<SystemCheck> {
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

    const payload = await readJsonOrNull<{ status?: unknown }>(response)
    if (!payload || payload.status !== 'ok') {
      throw new Error('file-server public healthz returned an invalid response')
    }
  }, 'public-unavailable')

  return toCheck(result, checkedAt)
}
