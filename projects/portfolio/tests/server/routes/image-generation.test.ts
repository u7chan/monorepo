import { APIError } from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatRoutes } from '#/server/routes/chat'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  save: vi.fn(),
  resolveConfig: vi.fn(),
  error: vi.fn(),
}))

vi.mock('#/server/features/image-generation/image-generation', () => ({
  generateImage: mocks.generate,
  IMAGE_GENERATION_CONTENT_TYPE: 'image/png',
  IMAGE_GENERATION_OUTPUT_FORMAT: 'png',
  IMAGE_GENERATION_SIZE: '1024x1024',
}))

vi.mock('#/server/features/chat-conversations/save-generated-image', () => ({
  saveGeneratedImage: mocks.save,
}))

vi.mock('#/server/features/chat-conversations/file-server-client', () => ({
  resolveFileServerConfig: mocks.resolveConfig,
}))

vi.mock('#/server/lib/logger', () => ({
  logger: { error: mocks.error },
}))

const env = {
  FILE_SERVER_URL: 'https://files.example.test',
  FILE_SERVER_PUBLIC_URL: 'https://files.example.test',
  FILE_SERVER_ADMIN_USERNAME: 'admin',
  FILE_SERVER_ADMIN_PASSWORD: 'password',
} as never

const IMAGE_MODEL = 'openai/gpt-image-2.5-flare'

const request = (body: Record<string, unknown> = {}) =>
  new Request('http://localhost/api/image/generations', {
    method: 'POST',
    headers: {
      'api-key': 'test-key',
      'base-url': 'https://api.example.test/v1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt: 'a blue house',
      model: IMAGE_MODEL,
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-1',
      ...body,
    }),
  })

describe('画像生成専用 API', () => {
  beforeEach(() => {
    mocks.generate.mockReset()
    mocks.save.mockReset()
    mocks.resolveConfig.mockReset()
    mocks.error.mockReset()
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
        model: IMAGE_MODEL,
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
        model: IMAGE_MODEL,
        image: { publicPath: '/public/portfolio/conversation-1/assistant-1-image-0.png' },
      })
      expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ model: IMAGE_MODEL }))
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

  describe('request validation', () => {
    it('model がない場合は provider を呼ばず 400 を返す', async () => {
      mocks.resolveConfig.mockReturnValue({
        baseUrl: 'https://files.example.test',
        publicBaseUrl: 'https://files.example.test',
        credentials: { username: 'admin', password: 'password' },
      })

      const response = await chatRoutes.request(request({ model: undefined }), undefined, env)

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        code: 'VALIDATION_ERROR',
        message: "Invalid request body 'model'",
        retryable: false,
      })
      expect(mocks.generate).not.toHaveBeenCalled()
    })

    it('model が形式に合わない場合は provider を呼ばず 400 を返す', async () => {
      mocks.resolveConfig.mockReturnValue({
        baseUrl: 'https://files.example.test',
        publicBaseUrl: 'https://files.example.test',
        credentials: { username: 'admin', password: 'password' },
      })

      const response = await chatRoutes.request(request({ model: 'gpt image 2.5 flare' }), undefined, env)

      expect(response.status).toBe(400)
      expect(mocks.generate).not.toHaveBeenCalled()
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
        model: IMAGE_MODEL,
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

    describe('provider error classification', () => {
      it('OpenAI image API の認証失敗は従来の provider 系分類を維持する', async () => {
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

      it('model または endpoint 非対応を専用エラーに分類し、安全な診断項目だけを記録する', async () => {
        mocks.resolveConfig.mockReturnValue({
          baseUrl: 'https://files.example.test',
          publicBaseUrl: 'https://files.example.test',
          credentials: { username: 'admin', password: 'password' },
        })
        const rawProviderMessage = 'raw provider body with credentials and implementation details'
        mocks.generate.mockRejectedValueOnce(
          createApiError(
            404,
            {
              message: rawProviderMessage,
              code: 'model_not_found',
              type: 'invalid_request_error',
              param: 'model',
            },
            'req_image_compatibility'
          )
        )

        const response = await chatRoutes.request(request(), undefined, env)
        const body = await response.json()

        expect(response.status).toBe(502)
        expect(body).toEqual({
          code: 'IMAGE_MODEL_ENDPOINT_INCOMPATIBLE',
          message:
            '画像生成プロバイダーがこのモデルまたはエンドポイントに対応していません。base URL の /images/generations 対応と、API キーで利用できる画像モデルを確認してください。',
          retryable: false,
        })
        expect(JSON.stringify(body)).not.toContain(rawProviderMessage)
        expect(mocks.error).toHaveBeenCalledWith(
          expect.objectContaining({
            errorCode: 'IMAGE_MODEL_ENDPOINT_INCOMPATIBLE',
            provider: {
              status: 404,
              code: 'model_not_found',
              type: 'invalid_request_error',
              param: 'model',
              requestId: 'req_image_compatibility',
            },
            request: {
              endpoint: '/images/generations',
              model: IMAGE_MODEL,
              size: '1024x1024',
              outputFormat: 'png',
              count: 1,
            },
          }),
          'Image generation failed'
        )
        expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(rawProviderMessage)
        expect(mocks.save).not.toHaveBeenCalled()
      })

      it('キーがモデルを許可していない 403 も専用エラーに分類する', async () => {
        mocks.resolveConfig.mockReturnValue({
          baseUrl: 'https://files.example.test',
          publicBaseUrl: 'https://files.example.test',
          credentials: { username: 'admin', password: 'password' },
        })
        const rawProviderMessage = 'raw key scope details'
        mocks.generate.mockRejectedValueOnce(
          createApiError(
            403,
            {
              message: rawProviderMessage,
              code: 'key_model_access_denied',
              type: 'auth_error',
            },
            'req_image_model_access'
          )
        )

        const response = await chatRoutes.request(request(), undefined, env)
        const body = await response.json()

        expect(response.status).toBe(502)
        expect(body).toEqual({
          code: 'IMAGE_MODEL_ENDPOINT_INCOMPATIBLE',
          message:
            '画像生成プロバイダーがこのモデルまたはエンドポイントに対応していません。base URL の /images/generations 対応と、API キーで利用できる画像モデルを確認してください。',
          retryable: false,
        })
        expect(JSON.stringify(body)).not.toContain(rawProviderMessage)
        expect(mocks.save).not.toHaveBeenCalled()
      })

      it('parameter 不正を専用エラーに分類し、provider本文を公開しない', async () => {
        mocks.resolveConfig.mockReturnValue({
          baseUrl: 'https://files.example.test',
          publicBaseUrl: 'https://files.example.test',
          credentials: { username: 'admin', password: 'password' },
        })
        const rawProviderMessage = 'raw provider body with unsupported parameter details'
        mocks.generate.mockRejectedValueOnce(
          createApiError(
            400,
            {
              message: rawProviderMessage,
              code: 'invalid_request_error',
              type: 'invalid_request_error',
              param: 'output_format',
            },
            'req_image_parameter'
          )
        )

        const response = await chatRoutes.request(request(), undefined, env)
        const body = await response.json()

        expect(response.status).toBe(502)
        expect(body).toEqual({
          code: 'IMAGE_REQUEST_INVALID',
          message:
            '画像生成リクエストのパラメータが受け付けられませんでした。プロバイダーが受け付ける model・size・output format・n・prompt を確認してください。',
          retryable: false,
        })
        expect(JSON.stringify(body)).not.toContain(rawProviderMessage)
        expect(mocks.save).not.toHaveBeenCalled()
      })

      it('provider の安全基準による拒否を専用エラーに分類する', async () => {
        mocks.resolveConfig.mockReturnValue({
          baseUrl: 'https://files.example.test',
          publicBaseUrl: 'https://files.example.test',
          credentials: { username: 'admin', password: 'password' },
        })
        const rawProviderMessage = 'raw moderation response details'
        mocks.generate.mockRejectedValueOnce(
          createApiError(
            400,
            {
              message: rawProviderMessage,
              code: 'moderation_blocked',
              type: 'image_generation_user_error',
            },
            'req_image_moderation'
          )
        )

        const response = await chatRoutes.request(request(), undefined, env)
        const body = await response.json()

        expect(response.status).toBe(502)
        expect(body).toEqual({
          code: 'IMAGE_PROVIDER_REJECTED',
          message:
            '画像生成プロバイダーにリクエストを拒否されました。prompt の内容とプロバイダーの安全基準・利用制限を確認してください。',
          retryable: false,
        })
        expect(JSON.stringify(body)).not.toContain(rawProviderMessage)
        expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(rawProviderMessage)
        expect(mocks.save).not.toHaveBeenCalled()
      })
    })
  })
})

function createApiError(status: number, body: Record<string, unknown>, requestId: string): APIError {
  return new APIError(status, body, undefined, new Headers({ 'x-request-id': requestId }))
}
