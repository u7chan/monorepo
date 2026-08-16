import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkFileExistsMock, dbExecuteMock, getDatabaseMock, loginToFileServerMock, readFileServerApiMock } =
  vi.hoisted(() => ({
    checkFileExistsMock: vi.fn(),
    dbExecuteMock: vi.fn(),
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
    checkFileExists: checkFileExistsMock,
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

describe('getSystemStatus', () => {
  beforeEach(() => {
    resetSystemStatusCacheForTests()
    dbExecuteMock.mockReset()
    getDatabaseMock.mockReset()
    loginToFileServerMock.mockReset()
    readFileServerApiMock.mockReset()
    checkFileExistsMock.mockReset()

    getDatabaseMock.mockReturnValue({ execute: dbExecuteMock })
    dbExecuteMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: schemaRows })
    loginToFileServerMock.mockResolvedValue('session-value')
    readFileServerApiMock.mockResolvedValue(undefined)
    checkFileExistsMock.mockResolvedValue(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('同じ設定では短時間キャッシュを利用し、force 時だけ再確認する', async () => {
    const first = await getSystemStatus(env)
    const cached = await getSystemStatus(env)

    expect(cached).toBe(first)
    expect(dbExecuteMock).toHaveBeenCalledTimes(2)
    expect(loginToFileServerMock).toHaveBeenCalledTimes(1)
    expect(checkFileExistsMock).toHaveBeenCalledTimes(1)

    dbExecuteMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: schemaRows })
    const refreshed = await getSystemStatus(env, { force: true })

    expect(refreshed).not.toBe(first)
    expect(dbExecuteMock).toHaveBeenCalledTimes(4)
    expect(loginToFileServerMock).toHaveBeenCalledTimes(2)
    expect(checkFileExistsMock).toHaveBeenCalledTimes(2)
  })
})
