import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { HonoEnv } from '#/server/routes/shared'
import { getSignedInEmail } from '#/server/routes/shared'

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

describe('getSignedInEmail', () => {
  it('signed cookie が有効なら email を返す', async () => {
    getSignedCookieMock.mockResolvedValue('test@example.com')

    const res = await app.request('/me', undefined, {
      COOKIE_SECRET: 'secret',
      COOKIE_NAME: 'session',
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ email: 'test@example.com' })
    expect(deleteCookieMock).not.toHaveBeenCalled()
  })

  it('cookie が不正なら null を返し cookie を削除する', async () => {
    getSignedCookieMock.mockResolvedValue(null)

    const res = await app.request('/me', undefined, {
      COOKIE_SECRET: 'secret',
      COOKIE_NAME: 'session',
    })

    await expect(res.json()).resolves.toEqual({ email: null })
    expect(deleteCookieMock).toHaveBeenCalled()
  })
})
