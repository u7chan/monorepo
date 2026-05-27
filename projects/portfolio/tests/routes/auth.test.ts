import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loginMock, logoutMock, setSignedCookieMock, deleteCookieMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  logoutMock: vi.fn(),
  setSignedCookieMock: vi.fn(),
  deleteCookieMock: vi.fn(),
}))

vi.mock('#/server/features/auth/auth', () => ({
  AuthenticationError: class AuthenticationError extends Error {},
  auth: {
    login: loginMock,
    logout: logoutMock,
  },
}))

vi.mock('hono/cookie', async () => {
  const actual = await vi.importActual<typeof import('hono/cookie')>('hono/cookie')

  return {
    ...actual,
    setSignedCookie: setSignedCookieMock,
    deleteCookie: deleteCookieMock,
  }
})

import app from '#/server/app'
import { resetSigninRateLimit } from '#/server/middleware/rate-limit'
import { AuthenticationError, authRoutes } from '#/server/routes/auth'

describe('authRoutes', () => {
  beforeEach(() => {
    resetSigninRateLimit()
    loginMock.mockReset()
    logoutMock.mockReset()
    setSignedCookieMock.mockReset()
    deleteCookieMock.mockReset()
  })

  it('認証成功時に cookie を設定する', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    vi.stubEnv('COOKIE_SECRET', 'secret')
    vi.stubEnv('COOKIE_NAME', 'session')
    vi.stubEnv('COOKIE_EXPIRES', '1d')

    const res = await authRoutes.request('/api/signin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'testexample',
      }),
    })

    expect(res.status).toBe(200)
    expect(loginMock).toHaveBeenCalledWith('postgres://db', 'test@example.com', 'testexample')
    expect(setSignedCookieMock).toHaveBeenCalledWith(
      expect.anything(),
      'session',
      'test@example.com',
      'secret',
      expect.objectContaining({
        maxAge: 86400,
      })
    )
  })

  it('signout で cookie を削除する', async () => {
    vi.stubEnv('COOKIE_NAME', 'session')

    const res = await authRoutes.request('/api/signout', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    expect(logoutMock).toHaveBeenCalled()
    expect(deleteCookieMock).toHaveBeenCalledWith(expect.anything(), 'session', { path: '/' })
  })

  it('不正な body は 400 を返す', async () => {
    const res = await authRoutes.request('/api/signin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'invalid-mail',
      }),
    })

    expect(res.status).toBe(400)
  })

  describe('signin rate limit', () => {
    it('同一 IP から 5 回連続で認証失敗すると 429 を返す', async () => {
      loginMock.mockRejectedValue(new AuthenticationError('認証に失敗しました'))

      for (let i = 0; i < 5; i += 1) {
        const res = await requestSignin('192.0.2.1')

        expect(res.status).toBe(401)
      }

      const res = await requestSignin('192.0.2.1')

      expect(res.status).toBe(429)
      await expect(res.json()).resolves.toEqual({ error: 'Too many login attempts. Please try again later.' })
    })

    it('認証成功時にカウンタをリセットする', async () => {
      loginMock.mockRejectedValueOnce(new AuthenticationError('認証に失敗しました'))

      const failedRes = await requestSignin('192.0.2.2')
      expect(failedRes.status).toBe(401)

      loginMock.mockResolvedValue(undefined)
      const successRes = await requestSignin('192.0.2.2')
      expect(successRes.status).toBe(200)

      loginMock.mockRejectedValue(new AuthenticationError('認証に失敗しました'))
      for (let i = 0; i < 4; i += 1) {
        const res = await requestSignin('192.0.2.2')

        expect(res.status).toBe(401)
      }
    })

    it('ブロックは IP ごとに独立し、1 分経過後に解除される', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      loginMock.mockRejectedValue(new AuthenticationError('認証に失敗しました'))

      for (let i = 0; i < 5; i += 1) {
        await requestSignin('192.0.2.3')
      }

      const blockedRes = await requestSignin('192.0.2.3')
      expect(blockedRes.status).toBe(429)

      const otherIpRes = await requestSignin('192.0.2.4')
      expect(otherIpRes.status).toBe(401)

      vi.advanceTimersByTime(60_000)

      const expiredRes = await requestSignin('192.0.2.3')
      expect(expiredRes.status).toBe(401)
    })
  })
})

const requestSignin = (ip: string) => {
  return app.request('/api/signin', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify({
      email: 'test@example.com',
      password: 'testexample',
    }),
  })
}
