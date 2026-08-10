import { describe, expect, it, vi } from 'vitest'
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

  it('file-server upload 失敗時は成功を返さない', async () => {
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
    expect(mocks.save).toHaveBeenCalled()
  })
})
