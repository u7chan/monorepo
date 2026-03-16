import { describe, expect, it, vi } from 'vitest'
import { modelsRoutes } from './models'

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
})
