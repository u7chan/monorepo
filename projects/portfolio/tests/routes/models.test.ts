import { describe, expect, it, vi } from 'vitest'
import { modelsRoutes } from '#/server/routes/models'

describe('modelsRoutes', () => {
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

    const res = await modelsRoutes.request('/api/fetch-models', {
      headers: {
        'api-key': 'api-key',
        'base-url': 'https://example.com',
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(['claude-3.7', 'gpt-4.1', 'gpt-4.1-mini'])
  })

  it('fetch 失敗時は空配列を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

    const res = await modelsRoutes.request('/api/fetch-models', {
      headers: {
        'api-key': 'api-key',
        'base-url': 'https://example.com',
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual([])
  })

  describe('画像生成モデルの一覧', () => {
    const requestImageModels = () =>
      modelsRoutes.request('/api/fetch-image-models', {
        headers: {
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
      })

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

      const res = await requestImageModels()

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

      const res = await requestImageModels()

      await expect(res.json()).resolves.toEqual(['gpt-image-2.5-sunburst', 'openai/gpt-image-2'])
    })

    it('fetch 失敗時は空配列を返す', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

      const res = await requestImageModels()

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual([])
    })
  })
})
