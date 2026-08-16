import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSignedCookieMock, getSystemStatusMock } = vi.hoisted(() => ({
  getSignedCookieMock: vi.fn(),
  getSystemStatusMock: vi.fn(),
}))

vi.mock('hono/cookie', async () => {
  const actual = await vi.importActual<typeof import('hono/cookie')>('hono/cookie')

  return {
    ...actual,
    getSignedCookie: getSignedCookieMock,
  }
})

vi.mock('#/server/features/system-status/system-status', () => ({
  getSystemStatus: getSystemStatusMock,
}))

import { systemStatusRoutes } from '#/server/routes/system-status'

const status = {
  status: 'ok' as const,
  checkedAt: '2026-04-19T00:00:00.000Z',
  checks: {
    database: {
      status: 'ok' as const,
      reason: 'ok',
      checkedAt: '2026-04-19T00:00:00.000Z',
      connection: { status: 'ok' as const, reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
      schema: { status: 'ok' as const, reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
    },
    fileServerHealth: { status: 'ok' as const, reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
    fileServerApi: {
      status: 'ok' as const,
      reason: 'ok',
      checkedAt: '2026-04-19T00:00:00.000Z',
      login: { status: 'ok' as const, reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
      read: { status: 'ok' as const, reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
    },
    fileServerPublic: { status: 'ok' as const, reason: 'ok', checkedAt: '2026-04-19T00:00:00.000Z' },
  },
}

describe('systemStatusRoutes', () => {
  beforeEach(() => {
    getSignedCookieMock.mockReset()
    getSystemStatusMock.mockReset()
    vi.stubEnv('COOKIE_SECRET', 'secret')
    vi.stubEnv('COOKIE_NAME', 'session')
  })

  it('未認証の GET は 401 を返し、system status を実行しない', async () => {
    getSignedCookieMock.mockResolvedValue(null)

    const res = await systemStatusRoutes.request('/api/system-status')

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Authentication error' })
    expect(getSystemStatusMock).not.toHaveBeenCalled()
  })

  it('認証済みの GET は status と no-store を返す', async () => {
    getSignedCookieMock.mockResolvedValue('test@example.com')
    getSystemStatusMock.mockResolvedValue(status)

    const res = await systemStatusRoutes.request('/api/system-status')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    await expect(res.json()).resolves.toEqual(status)
    expect(getSystemStatusMock).toHaveBeenCalledWith(expect.objectContaining({}), { force: false })
  })

  it('予期しないエラーでも機密情報を返さず 503 にする', async () => {
    getSignedCookieMock.mockResolvedValue('test@example.com')
    getSystemStatusMock.mockRejectedValue(new Error('postgres://secret/internal'))

    const res = await systemStatusRoutes.request('/api/system-status')

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ error: 'System status unavailable' })
  })

  it('refresh=1 はサーバーキャッシュを bypass する', async () => {
    getSignedCookieMock.mockResolvedValue('test@example.com')
    getSystemStatusMock.mockResolvedValue(status)

    const res = await systemStatusRoutes.request('/api/system-status?refresh=1')

    expect(res.status).toBe(200)
    expect(getSystemStatusMock).toHaveBeenCalledWith(expect.objectContaining({}), { force: true })
  })
})
