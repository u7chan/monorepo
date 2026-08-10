import { describe, expect, it, vi } from 'vitest'
import { saveGeneratedImage } from '#/server/features/chat-conversations/save-generated-image'

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  upload: vi.fn(),
  preview: vi.fn(),
  error: vi.fn(),
}))

vi.mock('#/server/features/chat-conversations/file-server-client', () => ({
  buildFileServerPreviewUrl: mocks.preview,
  loginToFileServer: mocks.login,
  uploadFileToFileServer: mocks.upload,
}))

vi.mock('#/server/lib/logger', () => ({
  logger: { error: mocks.error },
}))

const config = {
  baseUrl: 'https://files.example.test',
  publicBaseUrl: 'https://files.example.test',
  credentials: { username: 'admin', password: 'password' },
}

describe('生成画像の file-server 保存', () => {
  it('file server 未設定では保存を実行しない', async () => {
    const result = await saveGeneratedImage(
      {
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-1',
        content: new ArrayBuffer(1),
        contentType: 'image/png',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
      null
    )

    expect(result).toEqual({ ok: false, reason: 'file-server-unavailable' })
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('upload 成功後だけ public metadata を返す', async () => {
    mocks.login.mockResolvedValueOnce('session-1')
    mocks.upload.mockResolvedValueOnce(undefined)
    mocks.preview.mockReturnValueOnce('https://files.example.test/public/preview.png')

    const result = await saveGeneratedImage(
      {
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-1',
        content: new ArrayBuffer(1),
        contentType: 'image/png',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
      config
    )

    expect(mocks.upload).toHaveBeenCalledWith(config, 'session-1', {
      fileName: 'assistant-1-image-0.png',
      content: expect.any(ArrayBuffer),
      contentType: 'image/png',
      path: 'public/portfolio/conversation-1/assistant-1-image-0.png',
    })
    expect(result).toEqual({
      ok: true,
      image: {
        fileName: 'assistant-1-image-0.png',
        publicPath: '/public/portfolio/conversation-1/assistant-1-image-0.png',
        previewUrl: 'https://files.example.test/public/preview.png',
        contentType: 'image/png',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
    })
  })

  it('upload 失敗では成功 metadata を返さない', async () => {
    mocks.login.mockResolvedValueOnce('session-1')
    mocks.upload.mockRejectedValueOnce(new Error('upload failed'))

    const result = await saveGeneratedImage(
      {
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-1',
        content: new ArrayBuffer(1),
        contentType: 'image/png',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
      config
    )

    expect(result).toEqual({ ok: false, reason: 'upload-failed' })
    expect(mocks.error).toHaveBeenCalled()
  })
})
