import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}))

import { publicRoutes } from '#/server/routes/public'

describe('publicRoutes', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('FILE_SERVER_URL 未設定なら 503 を返す', async () => {
    vi.stubEnv('FILE_SERVER_URL', '')

    const res = await publicRoutes.request('/public/portfolio/c1/m1-block-0.html')

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ error: 'File server not configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('GET /public/* を file-server にプロキシする', async () => {
    vi.stubEnv('FILE_SERVER_URL', 'http://file-server:3000/')
    fetchMock.mockResolvedValue(
      new Response('<html>preview</html>', {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    )

    const res = await publicRoutes.request('/public/portfolio/c1/m1-block-0.html?download=0', {
      headers: {
        accept: 'text/html',
        cookie: 'session=keep-out',
      },
    })

    expect(fetchMock).toHaveBeenCalledWith('http://file-server:3000/public/portfolio/c1/m1-block-0.html?download=0', {
      method: 'GET',
      headers: expect.any(Headers),
      redirect: 'manual',
    })

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }]
    expect(init.headers.get('accept')).toBe('text/html')
    expect(init.headers.get('cookie')).toBeNull()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await expect(res.text()).resolves.toBe('<html>preview</html>')
  })
})
