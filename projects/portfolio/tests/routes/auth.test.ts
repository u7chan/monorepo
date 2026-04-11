import { describe, expect, it, vi } from 'vitest'

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

import { authRoutes } from '#/server/routes/auth'

describe('authRoutes', () => {
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
})
