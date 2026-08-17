import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dbEndMock, dbExecuteMock, fetchMock, getDatabaseMock, loginToFileServerMock, readFileServerApiMock } =
  vi.hoisted(() => ({
    dbEndMock: vi.fn(),
    dbExecuteMock: vi.fn(),
    fetchMock: vi.fn(),
    getDatabaseMock: vi.fn(),
    loginToFileServerMock: vi.fn(),
    readFileServerApiMock: vi.fn(),
  }))

vi.mock('#/db', () => ({
  getDatabase: getDatabaseMock,
}))

vi.mock('#/server/features/chat-conversations/file-server-client', async () => {
  const actual = await vi.importActual<typeof import('#/server/features/chat-conversations/file-server-client')>(
    '#/server/features/chat-conversations/file-server-client'
  )

  return {
    ...actual,
    loginToFileServer: loginToFileServerMock,
    readFileServerApi: readFileServerApiMock,
  }
})

import { getSystemStatus, resetSystemStatusCacheForTests } from '#/server/features/system-status/system-status'

const env = {
  DATABASE_URL: 'postgresql://db.internal:5432/portfolio',
  FILE_SERVER_URL: 'http://file-server:3000',
  FILE_SERVER_PUBLIC_URL: 'https://files.example.com',
  FILE_SERVER_ADMIN_USERNAME: 'admin',
  FILE_SERVER_ADMIN_PASSWORD: 'super-secret',
}

const schemaRows = [
  { table_name: 'users', column_name: 'id' },
  { table_name: 'users', column_name: 'email' },
  { table_name: 'users', column_name: 'password_hash' },
  { table_name: 'users', column_name: 'created_at' },
  { table_name: 'conversations', column_name: 'id' },
  { table_name: 'conversations', column_name: 'user_id' },
  { table_name: 'conversations', column_name: 'title' },
  { table_name: 'conversations', column_name: 'created_at' },
  { table_name: 'conversations', column_name: 'updated_at' },
  { table_name: 'messages', column_name: 'id' },
  { table_name: 'messages', column_name: 'conversation_id' },
  { table_name: 'messages', column_name: 'role' },
  { table_name: 'messages', column_name: 'content' },
  { table_name: 'messages', column_name: 'reasoning_content' },
  { table_name: 'messages', column_name: 'metadata' },
  { table_name: 'messages', column_name: 'created_at' },
  { table_name: 'prompt_templates', column_name: 'id' },
  { table_name: 'prompt_templates', column_name: 'input_type' },
  { table_name: 'prompt_templates', column_name: 'title' },
  { table_name: 'prompt_templates', column_name: 'placeholder' },
  { table_name: 'prompt_templates', column_name: 'prompt' },
  { table_name: 'prompt_templates', column_name: 'display_order' },
  { table_name: 'prompt_templates', column_name: 'enabled' },
  { table_name: 'prompt_templates', column_name: 'created_at' },
  { table_name: 'prompt_templates', column_name: 'updated_at' },
]

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('getSystemStatus', () => {
  beforeEach(() => {
    resetSystemStatusCacheForTests()
    dbEndMock.mockReset()
    dbExecuteMock.mockReset()
    fetchMock.mockReset()
    getDatabaseMock.mockReset()
    loginToFileServerMock.mockReset()
    readFileServerApiMock.mockReset()

    getDatabaseMock.mockReturnValue({ execute: dbExecuteMock, $client: { end: dbEndMock } })
    dbEndMock.mockResolvedValue(undefined)
    dbExecuteMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: schemaRows })
    loginToFileServerMock.mockResolvedValue('session-value')
    readFileServerApiMock.mockResolvedValue(undefined)
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('DB・file-server API・公開URLが正常なら ok を返す', async () => {
    const result = await getSystemStatus(env)

    expect(result.status).toBe('ok')
    expect(result.checks.database.status).toBe('ok')
    expect(result.checks.database.connection.status).toBe('ok')
    expect(result.checks.database.schema.status).toBe('ok')
    expect(result.checks.fileServerHealth.status).toBe('ok')
    expect(result.checks.fileServerApi.status).toBe('ok')
    expect(result.checks.fileServerPublic.status).toBe('ok')
    expect(dbEndMock).toHaveBeenCalledTimes(1)
    expect(getDatabaseMock).toHaveBeenCalledWith(
      env.DATABASE_URL,
      expect.objectContaining({
        connectionTimeoutMillis: expect.any(Number),
        query_timeout: expect.any(Number),
        statement_timeout: expect.any(Number),
      })
    )
    expect(fetchMock).toHaveBeenCalledWith(
      `${env.FILE_SERVER_PUBLIC_URL}/healthz`,
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    )
    expect(JSON.stringify(result)).not.toContain('db.internal')
    expect(JSON.stringify(result)).not.toContain('super-secret')
    expect(JSON.stringify(result)).not.toContain('file-server:3000')
  })

  it('スキーマが不足している場合は DB のスキーマ異常として返す', async () => {
    dbExecuteMock.mockReset()
    dbExecuteMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })

    const result = await getSystemStatus(env)

    expect(result.status).toBe('degraded')
    expect(result.checks.database.connection.status).toBe('ok')
    expect(result.checks.database.schema).toEqual(
      expect.objectContaining({ status: 'error', reason: 'schema-check-failed' })
    )
    expect(dbEndMock).toHaveBeenCalledTimes(1)
  })

  it('file-server ログインに失敗した場合は読み取り系への影響を示す', async () => {
    loginToFileServerMock.mockRejectedValue(new Error('invalid credentials'))

    const result = await getSystemStatus(env)

    expect(result.status).toBe('degraded')
    expect(result.checks.fileServerHealth.status).toBe('ok')
    expect(result.checks.fileServerApi).toEqual(expect.objectContaining({ status: 'error', reason: 'login-failed' }))
    expect(result.checks.fileServerApi.login).toEqual(
      expect.objectContaining({ status: 'error', reason: 'login-failed' })
    )
    expect(result.checks.fileServerApi.read).toEqual(
      expect.objectContaining({ status: 'error', reason: 'login-failed' })
    )
    expect(readFileServerApiMock).not.toHaveBeenCalled()
    expect(dbEndMock).toHaveBeenCalledTimes(1)
  })

  it('公開URLのルートが成功しても公開healthzが失敗した場合は異常として返す', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === `${env.FILE_SERVER_PUBLIC_URL}/healthz`) {
        return new Response(JSON.stringify({ status: 'unavailable' }), { status: 503 })
      }

      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    })

    const result = await getSystemStatus(env)

    expect(result.status).toBe('degraded')
    expect(result.checks.fileServerPublic).toEqual(
      expect.objectContaining({ status: 'error', reason: 'public-unavailable' })
    )
    expect(fetchMock).not.toHaveBeenCalledWith(`${env.FILE_SERVER_PUBLIC_URL}/`, expect.anything())
    expect(dbEndMock).toHaveBeenCalledTimes(1)
  })

  it('チェックが応答しない場合はタイムアウトとして返す', async () => {
    vi.useFakeTimers()
    dbExecuteMock.mockReset()
    dbExecuteMock.mockImplementation(() => new Promise(() => undefined))

    try {
      const resultPromise = getSystemStatus(env)
      await vi.advanceTimersByTimeAsync(3_000)
      const result = await resultPromise

      expect(result.checks.database.connection).toEqual(expect.objectContaining({ status: 'error', reason: 'timeout' }))
      expect(result.checks.database.schema).toEqual(expect.objectContaining({ status: 'error', reason: 'timeout' }))
      expect(dbEndMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('同じ設定の逐次呼び出しでは正常・degradedの結果を5秒キャッシュする', async () => {
    loginToFileServerMock.mockRejectedValue(new Error('invalid credentials'))

    const first = await getSystemStatus(env)
    const cached = await getSystemStatus(env)

    expect(cached).toBe(first)
    expect(cached.status).toBe('degraded')
    expect(dbExecuteMock).toHaveBeenCalledTimes(2)
    expect(dbEndMock).toHaveBeenCalledTimes(1)
    expect(loginToFileServerMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-04-19T00:00:00.000Z'))
      resetSystemStatusCacheForTests()
      loginToFileServerMock.mockResolvedValue('session-value')
      dbExecuteMock.mockReset()
      dbExecuteMock.mockResolvedValue({ rows: schemaRows })

      const fresh = await getSystemStatus(env)
      vi.advanceTimersByTime(4_999)
      const beforeExpiry = await getSystemStatus(env)
      vi.advanceTimersByTime(1)
      const atExpiry = await getSystemStatus(env)

      expect(beforeExpiry).toBe(fresh)
      expect(atExpiry).not.toBe(fresh)
      expect(dbExecuteMock).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('同時呼び出しでは依存チェックの開始を1回にまとめる', async () => {
    const connection = createDeferred<{ rows: Array<Record<string, string>> }>()
    const schema = createDeferred<{ rows: Array<Record<string, string>> }>()
    dbExecuteMock.mockReset()
    dbExecuteMock.mockImplementationOnce(() => connection.promise).mockImplementationOnce(() => schema.promise)

    const firstPromise = getSystemStatus(env)
    const secondPromise = getSystemStatus(env)

    expect(getDatabaseMock).toHaveBeenCalledTimes(1)
    expect(dbExecuteMock).toHaveBeenCalledTimes(2)
    expect(loginToFileServerMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    connection.resolve({ rows: [] })
    schema.resolve({ rows: schemaRows })
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(first).toBe(second)
    expect(dbEndMock).toHaveBeenCalledTimes(1)
  })

  it('設定keyが異なる場合は別々にチェックする', async () => {
    const otherEnv = { ...env, DATABASE_URL: 'postgresql://other.internal:5432/portfolio' }

    await Promise.all([getSystemStatus(env), getSystemStatus(otherEnv)])

    expect(getDatabaseMock).toHaveBeenCalledTimes(2)
    expect(getDatabaseMock).toHaveBeenNthCalledWith(1, env.DATABASE_URL, expect.anything())
    expect(getDatabaseMock).toHaveBeenNthCalledWith(2, otherEnv.DATABASE_URL, expect.anything())
    expect(dbEndMock).toHaveBeenCalledTimes(2)
  })

  it('top-level reject は固定エラーとし、完了から5秒 negative cooldown を適用する', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const dateError = new Error('postgres://secret/internal')
    const toISOStringSpy = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      throw dateError
    })

    try {
      await expect(getSystemStatus(env)).rejects.toThrow('System status unavailable')
      await expect(getSystemStatus(env)).rejects.toThrow('System status unavailable')
      expect(getDatabaseMock).not.toHaveBeenCalled()

      toISOStringSpy.mockRestore()
      vi.setSystemTime(5_000)
      dbExecuteMock.mockResolvedValue({ rows: schemaRows })
      await expect(getSystemStatus(env)).resolves.toMatchObject({ status: 'ok' })
      expect(getDatabaseMock).toHaveBeenCalledTimes(1)
    } finally {
      toISOStringSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('reset は pending の古い完了結果を再投入しない', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T00:00:00.000Z'))
    const firstConnection = createDeferred<{ rows: Array<Record<string, string>> }>()
    const firstSchema = createDeferred<{ rows: Array<Record<string, string>> }>()
    let queryCount = 0
    dbExecuteMock.mockReset()
    dbExecuteMock.mockImplementation(() => {
      queryCount += 1
      if (queryCount === 1) return firstConnection.promise
      if (queryCount === 2) return firstSchema.promise
      return Promise.resolve({ rows: schemaRows })
    })

    try {
      const oldResultPromise = getSystemStatus(env)
      resetSystemStatusCacheForTests()
      vi.setSystemTime(new Date('2026-04-19T00:00:01.000Z'))
      const newResult = await getSystemStatus(env)

      firstConnection.resolve({ rows: [] })
      firstSchema.resolve({ rows: schemaRows })
      await oldResultPromise

      const cached = await getSystemStatus(env)
      expect(cached).toBe(newResult)
      expect(cached.checkedAt).toBe('2026-04-19T00:00:01.000Z')
      expect(queryCount).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset は正常結果と negative cooldown の両方を消去する', async () => {
    vi.useFakeTimers()
    const toISOStringSpy = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      throw new Error('temporary failure')
    })

    try {
      await expect(getSystemStatus(env)).rejects.toThrow('System status unavailable')
      resetSystemStatusCacheForTests()
      toISOStringSpy.mockRestore()
      dbExecuteMock.mockResolvedValue({ rows: schemaRows })

      const result = await getSystemStatus(env)
      expect(result.status).toBe('ok')
      expect(getDatabaseMock).toHaveBeenCalledTimes(1)
    } finally {
      toISOStringSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
