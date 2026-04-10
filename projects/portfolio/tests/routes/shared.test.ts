import type { HonoEnv } from '#/server/routes/shared'
import { getSignedInEmail } from '#/server/routes/shared'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getSignedCookieMock, deleteCookieMock } = vi.hoisted(() => ({
  getSignedCookieMock: vi.fn(),
  deleteCookieMock: vi.fn(),
}))

vi.mock('hono/cookie', async () => {
  const actual = await vi.importActual<typeof import('hono/cookie')>('hono/cookie')

  return {
    ...actual,
    getSignedCookie: getSignedCookieMock,
    deleteCookie: deleteCookieMock,
  }
})

const app = new Hono<HonoEnv>().get('/me', async (c) => {
  const email = await getSignedInEmail(c)
  return c.json({ email })
})

afterEach(() => {
  vi.unstubAllEnvs()
  getSignedCookieMock.mockReset()
  deleteCookieMock.mockReset()
})

describe('getSignedInEmail', () => {
  it('signed cookie が有効なら email を返す', async () => {
    vi.stubEnv('COOKIE_SECRET', 'secret')
    vi.stubEnv('COOKIE_NAME', 'session')
    getSignedCookieMock.mockResolvedValue('test@example.com')

    const res = await app.request('/me')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ email: 'test@example.com' })
    expect(deleteCookieMock).not.toHaveBeenCalled()
  })

  it('cookie が不正なら null を返し cookie を削除する', async () => {
    vi.stubEnv('COOKIE_SECRET', 'secret')
    vi.stubEnv('COOKIE_NAME', 'session')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await app.request('/me')

    await expect(res.json()).resolves.toEqual({ email: null })
    expect(deleteCookieMock).toHaveBeenCalled()
  })

  it('cookie 設定が不足している場合は null を返し cookie API を呼ばない', async () => {
    getSignedCookieMock.mockResolvedValue(null)

    const res = await app.request('/me')

    await expect(res.json()).resolves.toEqual({ email: null })
    expect(deleteCookieMock).not.toHaveBeenCalled()
  })
})
