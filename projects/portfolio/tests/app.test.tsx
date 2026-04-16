import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from './helpers/mock-logger'

const importSubject = async () => {
  mockLogger()
  vi.doMock('hono-pino', () => ({
    pinoLogger: () => async (_c: any, next: any) => await next(),
  }))
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
  return mod.default
}

describe('app', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('AuthenticationError は 401 JSON に変換する', async () => {
    const app = await importSubject()
    const res = await app.request('/auth-error')

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'auth failed' })
  })

  it('その他の Error は 500 JSON に変換する', async () => {
    const app = await importSubject()
    const res = await app.request('/unknown-error')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'boom' })
  })
})
