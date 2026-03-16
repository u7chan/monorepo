import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const importSubject = async () => {
  vi.doMock('./routes/auth', () => {
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
  vi.doMock('./routes/chat', () => ({
    chatRoutes: new Hono().get('/unknown-error', () => {
      throw new Error('boom')
    }),
  }))
  vi.doMock('./routes/conversations', () => ({
    conversationsRoutes: new Hono(),
  }))
  vi.doMock('./routes/models', () => ({
    modelsRoutes: new Hono(),
  }))
  vi.doMock('./routes/html', () => ({
    htmlRoutes: new Hono(),
  }))

  const mod = await import('./app')
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
