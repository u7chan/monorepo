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

import { htmlRoutes } from './html'

describe('htmlRoutes', () => {
  it('development では src 配下の asset を返す', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    getSignedCookieMock.mockResolvedValue('test@example.com')

    const res = await htmlRoutes.request('/')
    const html = await res.text()

    expect(html).toContain('/src/client/main.css')
    expect(html).toContain('/src/client/main.tsx')
    expect(html).toContain('test@example.com')
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
