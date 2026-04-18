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
    expect(logger.child).toHaveBeenCalledWith({ requestId })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('その他の Error は 500 JSON に変換する', async () => {
    const { app, logger } = await importSubject()
    const res = await app.request('/unknown-error')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'boom' })
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
