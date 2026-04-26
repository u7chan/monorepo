import { describe, expect, it, vi } from 'vitest'

const { getSignedCookieMock } = vi.hoisted(() => ({
  getSignedCookieMock: vi.fn(),
}))

vi.mock('hono/cookie', async () => {
  const actual = await vi.importActual<typeof import('hono/cookie')>('hono/cookie')

  return {
    ...actual,
    getSignedCookie: getSignedCookieMock,
  }
})

import { htmlRoutes } from '#/server/routes/html'

describe('htmlRoutes', () => {
  it('development では src 配下の asset を返す', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COOKIE_EXPIRES', '1d')
    getSignedCookieMock.mockResolvedValue('test@example.com')

    const res = await htmlRoutes.request('/')
    const html = await res.text()

    expect(html).toContain('/src/client/main.css')
    expect(html).toContain('/src/client/main.tsx')
    expect(html).toContain('test@example.com')
    expect(html).toContain('&quot;loginExpiresLabel&quot;:&quot;1日&quot;')
  })

  it('production では static asset を返す', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await htmlRoutes.request('/')
    const html = await res.text()

    expect(html).toContain('/static/main.css')
    expect(html).toContain('/static/client.js')
  })
})
