import { describe, expect, it, vi } from 'vitest'
import { createConversationFixture } from '../fixtures'

const { getSignedCookieMock, repositoryMock } = vi.hoisted(() => ({
  getSignedCookieMock: vi.fn(),
  repositoryMock: {
    read: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMessages: vi.fn(),
    updateMessageMetadata: vi.fn(),
    saveGeneratedFile: vi.fn(),
  },
}))

vi.mock('#/server/features/chat-conversations/repository', () => ({
  chatConversationRepository: repositoryMock,
}))

vi.mock('hono/cookie', async () => {
  const actual = await vi.importActual<typeof import('hono/cookie')>('hono/cookie')

  return {
    ...actual,
    getSignedCookie: getSignedCookieMock,
  }
})

import { conversationsRoutes } from '#/server/routes/conversations'

describe('conversationsRoutes', () => {
  it('未認証の GET は 401 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await conversationsRoutes.request('/api/conversations')

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Authentication error' })
    expect(repositoryMock.read).not.toHaveBeenCalled()
  })

  it('認証済み GET は repository.read の結果を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    const fixture = createConversationFixture()
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.read.mockResolvedValue([fixture])

    const res = await conversationsRoutes.request('/api/conversations')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: [fixture] })
    expect(repositoryMock.read).toHaveBeenCalledWith('postgres://db', 'test@example.com')
  })

  it('認証済み GET は updatedAt を JSON 文字列で返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.read.mockResolvedValue([
      {
        ...createConversationFixture(),
        updatedAt: new Date('2026-04-14T12:34:56.000Z'),
      },
    ])

    const res = await conversationsRoutes.request('/api/conversations')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      data: [
        {
          ...createConversationFixture(),
          updatedAt: '2026-04-14T12:34:56.000Z',
        },
      ],
    })
  })

  it('未認証の POST は 401 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await conversationsRoutes.request('/api/conversations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(createConversationFixture()),
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Authentication error' })
  })

  it('未認証の DELETE は 401 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await conversationsRoutes.request('/api/conversations?ids=conversation-1', { method: 'DELETE' })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Authentication error' })
  })

  it('未認証の DELETE /messages は 401 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await conversationsRoutes.request('/api/conversations/messages?ids=message-1', { method: 'DELETE' })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Authentication error' })
  })

  it('DELETE は単一 query を配列に変換して repository.delete に渡す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.delete.mockResolvedValue({
      success: true,
      deletedIds: ['conversation-1'],
      failedIds: [],
    })

    const res = await conversationsRoutes.request('/api/conversations?ids=conversation-1', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(repositoryMock.delete).toHaveBeenCalledWith('postgres://db', 'test@example.com', ['conversation-1'])
  })

  it('PATCH /messages/metadata は認証必須', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await conversationsRoutes.request('/api/conversations/messages/metadata', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', messageId: 'm1', metadata: {} }),
    })

    expect(res.status).toBe(401)
  })

  it('PATCH /messages/metadata は assistant 以外なら 400 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.updateMessageMetadata.mockResolvedValue({ ok: false, reason: 'invalid-role' })

    const res = await conversationsRoutes.request('/api/conversations/messages/metadata', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', messageId: 'm1', metadata: { finishReason: 'stop' } }),
    })

    expect(res.status).toBe(400)
  })

  it('PATCH /messages/metadata は他ユーザーに forbidden で 403 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.updateMessageMetadata.mockResolvedValue({ ok: false, reason: 'forbidden' })

    const res = await conversationsRoutes.request('/api/conversations/messages/metadata', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', messageId: 'm1', metadata: {} }),
    })

    expect(res.status).toBe(403)
  })

  it('PATCH /messages/metadata は成功時に更新後の metadata を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.updateMessageMetadata.mockResolvedValue({
      ok: true,
      metadata: { model: 'gpt', usage: {}, finishReason: 'stop' },
    })

    const res = await conversationsRoutes.request('/api/conversations/messages/metadata', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', messageId: 'm1', metadata: { finishReason: 'stop' } }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      metadata: { model: 'gpt', usage: {}, finishReason: 'stop' },
    })
  })

  it('POST /messages/generated-files は file-server 未設定なら 503 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    vi.stubEnv('FILE_SERVER_URL', '')
    vi.stubEnv('FILE_SERVER_ADMIN_USERNAME', '')
    vi.stubEnv('FILE_SERVER_ADMIN_PASSWORD', '')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.saveGeneratedFile.mockResolvedValue({ ok: false, reason: 'file-server-unavailable' })

    const res = await conversationsRoutes.request('/api/conversations/messages/generated-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'c1',
        messageId: 'm1',
        blockIndex: 0,
        language: 'html',
        content: '<p/>',
      }),
    })

    expect(res.status).toBe(503)
  })

  it('POST /messages/generated-files は成功時に file と alreadyExisted を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    const file = {
      blockIndex: 0,
      language: 'html',
      fileName: 'm1-block-0.html',
      publicPath: '/public/portfolio/c1/m1-block-0.html',
      previewUrl: 'http://fs/public/portfolio/c1/m1-block-0.html',
      contentType: 'text/html; charset=utf-8',
      createdAt: '2026-04-19T00:00:00.000Z',
    }
    repositoryMock.saveGeneratedFile.mockResolvedValue({ ok: true, file, alreadyExisted: false })

    const res = await conversationsRoutes.request('/api/conversations/messages/generated-files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'c1',
        messageId: 'm1',
        blockIndex: 0,
        language: 'html',
        content: '<p/>',
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ file, alreadyExisted: false })
  })

  it('DELETE /messages は複数 query を repository.deleteMessages に渡す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue('test@example.com')
    repositoryMock.deleteMessages.mockResolvedValue({
      success: true,
      deletedMessageIds: ['message-1', 'message-2'],
      failedMessageIds: [],
      deletedConversationIds: [],
    })

    const res = await conversationsRoutes.request('/api/conversations/messages?ids=message-1&ids=message-2', {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    expect(repositoryMock.deleteMessages).toHaveBeenCalledWith('postgres://db', 'test@example.com', [
      'message-1',
      'message-2',
    ])
  })
})
