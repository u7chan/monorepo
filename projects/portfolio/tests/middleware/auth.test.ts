import type { HonoEnv } from '#/server/routes/shared'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

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

import { requireAuth } from '#/server/middleware/auth'

const app = new Hono<HonoEnv>().get('/protected', requireAuth, (c) => {
  return c.json({ email: c.get('email') })
})

describe('requireAuth', () => {
  describe('未認証リクエスト', () => {
    it('401 と { error: "Authentication error" } を返す', async () => {
      vi.stubEnv('COOKIE_SECRET', 'secret')
      vi.stubEnv('COOKIE_NAME', 'session')
      getSignedCookieMock.mockResolvedValue(null)

      const res = await app.request('/protected')

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({ error: 'Authentication error' })
    })
  })

  describe('認証済みリクエスト', () => {
    it('次のハンドラに進み email を context にセットする', async () => {
      vi.stubEnv('COOKIE_SECRET', 'secret')
      vi.stubEnv('COOKIE_NAME', 'session')
      getSignedCookieMock.mockResolvedValue('test@example.com')

      const res = await app.request('/protected')

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ email: 'test@example.com' })
    })
  })
})
