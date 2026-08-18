import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSystemStatusMock } = vi.hoisted(() => ({
  getSystemStatusMock: vi.fn(),
}))

vi.mock('#/server/features/system-status/system-status', async () => {
  const actual = await vi.importActual<typeof import('#/server/features/system-status/system-status')>(
    '#/server/features/system-status/system-status'
  )

  return {
    ...actual,
    getSystemStatus: getSystemStatusMock,
  }
})

import { systemStatusRoutes } from '#/server/routes/system-status'

const checkedAt = '2026-04-19T00:00:00.000Z'
const status = {
  status: 'ok' as const,
  checkedAt,
  checks: {
    database: {
      status: 'ok' as const,
      reason: 'ok' as const,
      checkedAt,
      connection: { status: 'ok' as const, reason: 'ok' as const, checkedAt },
      schema: { status: 'ok' as const, reason: 'future-reason', checkedAt },
    },
    fileServerHealth: { status: 'ok' as const, reason: 'ok' as const, checkedAt },
    fileServerApi: {
      status: 'ok' as const,
      reason: 'ok' as const,
      checkedAt,
      login: { status: 'ok' as const, reason: 'ok' as const, checkedAt },
      read: { status: 'ok' as const, reason: 'ok' as const, checkedAt },
    },
    fileServerPublic: { status: 'ok' as const, reason: 'ok' as const, checkedAt },
  },
  secret: 'password',
  internalUrl: 'http://file-server:3000',
  responseBody: { token: 'token' },
  stack: 'Error: secret',
}

const expectedPublicStatus = {
  status: 'ok',
  checkedAt,
  checks: {
    database: {
      status: 'ok',
      reason: 'ok',
      checkedAt,
      connection: { status: 'ok', reason: 'ok', checkedAt },
      schema: { status: 'ok', reason: 'check-failed', checkedAt },
    },
    fileServerHealth: { status: 'ok', reason: 'ok', checkedAt },
    fileServerApi: {
      status: 'ok',
      reason: 'ok',
      checkedAt,
      login: { status: 'ok', reason: 'ok', checkedAt },
      read: { status: 'ok', reason: 'ok', checkedAt },
    },
    fileServerPublic: { status: 'ok', reason: 'ok', checkedAt },
  },
}

describe('systemStatusRoutes', () => {
  beforeEach(() => {
    getSystemStatusMock.mockReset()
  })

  it('Cookie の有無や内容にかかわらず公開 status を返す', async () => {
    getSystemStatusMock.mockResolvedValue(status)

    for (const cookie of [undefined, 'session=valid', 'session=invalid']) {
      const res = await systemStatusRoutes.request('/api/system-status', {
        headers: cookie ? { Cookie: cookie } : undefined,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      await expect(res.json()).resolves.toEqual(expectedPublicStatus)
    }

    expect(getSystemStatusMock).toHaveBeenCalledTimes(3)
    expect(getSystemStatusMock).toHaveBeenCalledWith(expect.objectContaining({}))
  })

  it('通常 GET と refresh query は同じ処理を実行し force を渡さない', async () => {
    getSystemStatusMock.mockResolvedValue(status)

    const normal = await systemStatusRoutes.request('/api/system-status')
    const refreshOne = await systemStatusRoutes.request('/api/system-status?refresh=1')
    const refreshTrue = await systemStatusRoutes.request('/api/system-status?refresh=true')

    expect(normal.status).toBe(200)
    expect(refreshOne.status).toBe(200)
    expect(refreshTrue.status).toBe(200)
    expect(getSystemStatusMock).toHaveBeenCalledTimes(3)
    for (const call of getSystemStatusMock.mock.calls) {
      expect(call).toHaveLength(1)
      expect(call[0]).toEqual(expect.objectContaining({}))
    }
  })

  it('予期しないエラーでも機密情報を返さず固定 503 にする', async () => {
    getSystemStatusMock.mockRejectedValue(new Error('postgres://secret/internal'))

    const res = await systemStatusRoutes.request('/api/system-status')

    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({ error: 'System status unavailable' })
    expect(JSON.stringify(body)).not.toContain('postgres://secret/internal')
  })
})
