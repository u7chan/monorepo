import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from './helpers/mock-logger'

const importSubject = async () => {
  const logger = mockLogger()
  vi.doMock('#/server/routes/auth', () => {
    class AuthenticationError extends Error {}

    const authRoutes = new Hono()
      .get('/auth-error', () => {
        throw new AuthenticationError('auth failed')
      })
      .get('/auth-ok', (c) => c.json({ ok: true }))

    return {
      AuthenticationError,
      authRoutes,
    }
  })
  vi.doMock('#/server/routes/chat', () => ({
    chatRoutes: new Hono().get('/unknown-error', () => {
      throw new Error('boom')
    }),
  }))
  vi.doMock('#/server/routes/conversations', () => ({
    conversationsRoutes: new Hono(),
  }))
  vi.doMock('#/server/routes/models', () => ({
    modelsRoutes: new Hono(),
  }))
  vi.doMock('#/server/routes/html', () => ({
    htmlRoutes: new Hono(),
  }))

  const mod = await import('#/server/app')
  return {
    app: mod.default,
    logger,
  }
}

const expectSecurityHeaders = (res: Response) => {
  expect(res.headers.get('Content-Security-Policy')).toBe(
    "base-uri 'self'; default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'"
  )
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  expect(res.headers.get('Permissions-Policy')).toBe(
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()'
  )
}

describe('app', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('AuthenticationError は 401 JSON に変換する', async () => {
    const { app, logger } = await importSubject()
    const res = await app.request('/auth-error')
    const requestId = res.headers.get('X-Request-Id')

    expect(res.status).toBe(401)
    expect(requestId).toEqual(expect.any(String))
    await expect(res.json()).resolves.toEqual({ error: 'auth failed' })
    expectSecurityHeaders(res)
    expect(logger.child).toHaveBeenCalledWith({ requestId })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('その他の Error は 500 JSON に変換する', async () => {
    const { app, logger } = await importSubject()
    const res = await app.request('/unknown-error')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'boom' })
    expectSecurityHeaders(res)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('production では AuthenticationError の詳細を隠す', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { app } = await importSubject()
    const res = await app.request('/auth-error')

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Authentication error' })
  })

  it('production ではその他の Error の詳細を隠す', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { app } = await importSubject()
    const res = await app.request('/unknown-error')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Internal Server Error' })
  })

  it('正常レスポンスにセキュリティヘッダーを付与する', async () => {
    const { app } = await importSubject()
    const res = await app.request('/auth-ok')

    expect(res.status).toBe(200)
    expectSecurityHeaders(res)
  })

  describe('Content-Security-Policy img-src', () => {
    it('FILE_SERVER_PUBLIC_URL の http originだけを追加し、pathとqueryを含めない', async () => {
      vi.stubEnv('FILE_SERVER_PUBLIC_URL', 'http://files.example.com/public/portfolio?cache=1')
      const { app } = await importSubject()
      const res = await app.request('/auth-ok')
      const policy = res.headers.get('Content-Security-Policy')

      expect(policy).toContain("img-src 'self' data: https: http://files.example.com;")
      expect(policy).not.toContain('/public/portfolio')
      expect(policy).not.toContain('?cache=1')
      expect(policy).toContain("connect-src 'self'; frame-src 'self'")
      expect(policy).not.toContain("connect-src 'self' http://files.example.com")
    })

    it('FILE_SERVER_PUBLIC_URL が空または未設定なら file-server originを追加しない', async () => {
      const { app: unsetApp } = await importSubject()
      const unsetResponse = await unsetApp.request('/auth-ok')
      expect(unsetResponse.headers.get('Content-Security-Policy')).toBe(
        "base-uri 'self'; default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'"
      )

      vi.stubEnv('FILE_SERVER_PUBLIC_URL', '')
      const { app } = await importSubject()
      const response = await app.request('/auth-ok')

      expect(response.headers.get('Content-Security-Policy')).toBe(
        "base-uri 'self'; default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'"
      )
    })

    it('不正な URL または非 HTTP(S) URLを img-src に追加しない', async () => {
      vi.stubEnv('FILE_SERVER_PUBLIC_URL', 'not a url')
      const { app: invalidApp } = await importSubject()
      const invalidResponse = await invalidApp.request('/auth-ok')
      expect(invalidResponse.headers.get('Content-Security-Policy')).not.toContain('not a url')

      vi.stubEnv('FILE_SERVER_PUBLIC_URL', 'ftp://files.example.com/public')
      const { app } = await importSubject()
      const response = await app.request('/auth-ok')

      expect(response.headers.get('Content-Security-Policy')).not.toContain('ftp://files.example.com')
      expect(response.headers.get('Content-Security-Policy')).toContain("img-src 'self' data: https:;")
    })

    it('credentials付きURLを追加せず、既存のsecurity directivesとconnect-srcを維持する', async () => {
      vi.stubEnv('FILE_SERVER_PUBLIC_URL', 'http://user:password@files.example.com:8010/public')
      const { app } = await importSubject()
      const res = await app.request('/auth-ok')

      expect(res.headers.get('Content-Security-Policy')).toBe(
        "base-uri 'self'; default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'"
      )
    })
  })
})
