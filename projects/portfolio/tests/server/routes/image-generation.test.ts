import { APIError } from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatRoutes } from '#/server/routes/chat'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  save: vi.fn(),
  resolveConfig: vi.fn(),
}))

vi.mock('#/server/features/image-generation/image-generation', () => ({
  generateImage: mocks.generate,
  IMAGE_GENERATION_CONTENT_TYPE: 'image/png',
}))

vi.mock('#/server/features/chat-conversations/save-generated-image', () => ({
  saveGeneratedImage: mocks.save,
}))

vi.mock('#/server/features/chat-conversations/file-server-client', () => ({
  resolveFileServerConfig: mocks.resolveConfig,
}))

const env = {
  FILE_SERVER_URL: 'https://files.example.test',
  FILE_SERVER_PUBLIC_URL: 'https://files.example.test',
  FILE_SERVER_ADMIN_USERNAME: 'admin',
  FILE_SERVER_ADMIN_PASSWORD: 'password',
} as never

const request = () =>
  new Request('http://localhost/api/image/generations', {
    method: 'POST',
    headers: {
      'api-key': 'test-key',
      'base-url': 'https://api.example.test/v1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt: 'a blue house',
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-1',
    }),
  })

describe('画像生成専用 API', () => {
  beforeEach(() => {
    mocks.generate.mockReset()
    mocks.save.mockReset()
    mocks.resolveConfig.mockReset()
  })

  describe('成功', () => {
    it('file-server upload 成功時だけ生成 metadata を返す', async () => {
      mocks.resolveConfig.mockReturnValue({
        baseUrl: 'https://files.example.test',
        publicBaseUrl: 'https://files.example.test',
        credentials: { username: 'admin', password: 'password' },
      })
      mocks.generate.mockResolvedValueOnce({
        id: 'image-1',
        created: 1_700_000_000,
        model: 'gpt-image-2',
        content: new ArrayBuffer(1),
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      })
      mocks.save.mockResolvedValueOnce({
        ok: true,
        image: {
          fileName: 'assistant-1-image-0.png',
          publicPath: '/public/portfolio/conversation-1/assistant-1-image-0.png',
          previewUrl: 'https://files.example.test/public/portfolio/conversation-1/assistant-1-image-0.png',
          contentType: 'image/png',
          createdAt: '2023-11-14T22:13:20.000Z',
        },
      })

      const response = await chatRoutes.request(request(), undefined, env)

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: 'image-1',
        model: 'gpt-image-2',
        image: { publicPath: '/public/portfolio/conversation-1/assistant-1-image-0.png' },
      })
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conversation-1',
          assistantMessageId: 'assistant-1',
          contentType: 'image/png',
        }),
        expect.any(Object)
      )
    })
  })

  describe('エラー分類', () => {
    it('file-server 設定が不足している場合は保存先未設定エラーを返す', async () => {
      mocks.resolveConfig.mockReturnValue(null)

      const response = await chatRoutes.request(request(), undefined, env)

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        code: 'IMAGE_STORAGE_NOT_CONFIGURED',
        message:
          '生成画像の保存先が未設定です。file-server の接続先・公開 URL・管理者ユーザー名・パスワードを確認してください。',
        retryable: false,
      })
      expect(mocks.generate).not.toHaveBeenCalled()
    })

    it('file-server upload 失敗時は保存失敗エラーを返す', async () => {
      mocks.resolveConfig.mockReturnValue({
        baseUrl: 'https://files.example.test',
        publicBaseUrl: 'https://files.example.test',
        credentials: { username: 'admin', password: 'password' },
      })
      mocks.generate.mockResolvedValueOnce({
        id: 'image-1',
        created: 1_700_000_000,
        model: 'gpt-image-2',
        content: new ArrayBuffer(1),
        usage: {},
      })
      mocks.save.mockResolvedValueOnce({ ok: false, reason: 'upload-failed' })

      const response = await chatRoutes.request(request(), undefined, env)

      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({
        code: 'IMAGE_STORAGE_FAILED',
        message:
          '生成画像を保存できませんでした。file-server のログイン・アップロード設定と接続状態を確認して再試行してください。',
        retryable: true,
      })
      expect(mocks.save).toHaveBeenCalled()
    })

    it('OpenAI image API の失敗は provider 系 error classification を維持する', async () => {
      mocks.resolveConfig.mockReturnValue({
        baseUrl: 'https://files.example.test',
        publicBaseUrl: 'https://files.example.test',
        credentials: { username: 'admin', password: 'password' },
      })
      mocks.generate.mockRejectedValueOnce(
        new APIError(
          401,
          {
            message: 'Invalid API key',
          },
          undefined,
          new Headers()
        )
      )

      const response = await chatRoutes.request(request(), undefined, env)

      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({
        code: 'AUTHENTICATION_FAILED',
        message: 'API キーが無効か、利用を許可されていません。設定を確認してください。',
        retryable: false,
      })
      expect(mocks.save).not.toHaveBeenCalled()
    })
  })
})
