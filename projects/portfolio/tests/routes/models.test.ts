import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSignedCookieMock } = vi.hoisted(() => ({ getSignedCookieMock: vi.fn() }))

vi.mock('hono/cookie', async () => {
  const actual = await vi.importActual<typeof import('hono/cookie')>('hono/cookie')

  return {
    ...actual,
    getSignedCookie: getSignedCookieMock,
    deleteCookie: vi.fn(),
  }
})

import { modelsRoutes } from '#/server/routes/models'

const requestModels = (path: string, baseURL = 'https://example.com/v1') =>
  modelsRoutes.request(path, {
    headers: {
      'api-key': 'api-key',
      'base-url': baseURL,
    },
  })

describe('modelsRoutes', () => {
  beforeEach(() => {
    getSignedCookieMock.mockResolvedValue('test@example.com')
  })

  describe('認証', () => {
    it('未ログインでは 401 を返し、上流へ問い合わせない', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      getSignedCookieMock.mockResolvedValue(null)

      const res = await requestModels('/api/fetch-models')

      expect(res.status).toBe(401)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('base-url の検証', () => {
    it('http/https 以外の scheme は 400 を返し、上流へ問い合わせない', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const res = await requestModels('/api/fetch-models', 'file:///etc/passwd')

      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('モデル一覧', () => {
    it('必須 header がない場合は 400 を返す', async () => {
      const res = await modelsRoutes.request('/api/fetch-models')

      expect(res.status).toBe(400)
    })

    it('取得した model id をソートして返す', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }, { id: 'claude-3.7' }],
          }),
        })
      )

      const res = await requestModels('/api/fetch-models')

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual(['claude-3.7', 'gpt-4.1', 'gpt-4.1-mini'])
    })

    it('末尾スラッシュを除去し、リダイレクトを追わずに /models を取得する', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [] }),
      })
      vi.stubGlobal('fetch', fetchMock)

      await requestModels('/api/fetch-models', 'https://example.com/v1///')

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/v1/models',
        expect.objectContaining({ redirect: 'error' })
      )
    })

    it('fetch 失敗時は空配列を返す', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

      const res = await requestModels('/api/fetch-models')

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual([])
    })
  })

  describe('画像生成モデルの一覧', () => {
    it('必須 header がない場合は 400 を返す', async () => {
      const res = await modelsRoutes.request('/api/fetch-image-models')

      expect(res.status).toBe(400)
    })

    it('mode が image_generation のモデルだけを返す', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: [
              { id: 'openai/gpt-image-2.5-flare', mode: 'image_generation' },
              { id: 'openai/gpt-4.1-mini', mode: 'chat' },
              { id: 'openai/gpt-image-2', mode: 'image_generation' },
              { id: 'text-embedding-3-small', mode: 'embedding' },
            ],
          }),
        })
      )

      const res = await requestModels('/api/fetch-image-models')

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual(['openai/gpt-image-2', 'openai/gpt-image-2.5-flare'])
    })

    it('mode を返さないプロキシでは gpt-image- の名前で抽出する', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: [
              { id: 'gpt-image-2.5-sunburst', mode: '' },
              { id: 'openai/gpt-image-2' },
              { id: 'gpt-4.1-mini' },
              { id: 'my-gpt-image-model' },
            ],
          }),
        })
      )

      const res = await requestModels('/api/fetch-image-models')

      await expect(res.json()).resolves.toEqual(['gpt-image-2.5-sunburst', 'openai/gpt-image-2'])
    })

    it('fetch 失敗時は空配列を返す', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

      const res = await requestModels('/api/fetch-image-models')

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual([])
    })
  })
})
