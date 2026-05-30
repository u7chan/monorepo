import { describe, expect, it, vi } from 'vitest'

const { repositoryMock } = vi.hoisted(() => ({
  repositoryMock: {
    read: vi.fn(),
  },
}))

vi.mock('#/server/features/prompt-templates/repository', () => ({
  promptTemplateRepository: repositoryMock,
}))

import { promptTemplatesRoutes } from '#/server/routes/prompt-templates'

describe('promptTemplatesRoutes', () => {
  it('未認証でも有効なテンプレート一覧を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    repositoryMock.read.mockResolvedValue([
      {
        id: 'translate_en',
        inputType: 'textarea',
        title: '英語へ翻訳',
        placeholder: '入力',
        prompt: 'Translate',
      },
    ])

    const res = await promptTemplatesRoutes.request('/api/prompt-templates')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      data: [
        {
          id: 'translate_en',
          inputType: 'textarea',
          title: '英語へ翻訳',
          placeholder: '入力',
          prompt: 'Translate',
        },
      ],
    })
    expect(repositoryMock.read).toHaveBeenCalledWith('postgres://db')
  })

  it('取得失敗時は空配列と 500 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    repositoryMock.read.mockRejectedValue(new Error('database unavailable'))

    const res = await promptTemplatesRoutes.request('/api/prompt-templates')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ data: [] })
  })
})
