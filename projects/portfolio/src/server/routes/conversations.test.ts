import { createConversationFixture } from '#/server/test/fixtures'
import { describe, expect, it, vi } from 'vitest'

const { getSignedCookieMock, repositoryMock } = vi.hoisted(() => ({
  getSignedCookieMock: vi.fn(),
  repositoryMock: {
    read: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMessages: vi.fn(),
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

import { conversationsRoutes } from './conversations'

describe('conversationsRoutes', () => {
  it('未認証の GET は空配列を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://db')
    getSignedCookieMock.mockResolvedValue(null)

    const res = await conversationsRoutes.request('/api/conversations')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: [] })
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
