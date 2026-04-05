import { beforeEach, describe, expect, it, vi } from 'vitest'

const importSubject = async (params: {
  users: Array<{ id: string; email: string }>
  rows: Array<Record<string, unknown>>
}) => {
  const db = {
    select: vi.fn((fields?: unknown) => {
      if (!fields) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(params.users),
          })),
        }
      }

      return {
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(params.rows),
            })),
          })),
        })),
      }
    }),
  }

  vi.doMock('#/db', () => ({
    getDatabase: vi.fn(() => db),
  }))

  const { readConversations } = await import('#/server/features/chat-conversations/read-conversations')
  return { readConversations }
}

describe('readConversations', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('ユーザーが存在しない場合は null を返す', async () => {
    const { readConversations } = await importSubject({ users: [], rows: [] })

    await expect(readConversations('postgres://db', 'missing@example.com')).resolves.toBeNull()
  })

  it('会話ごとにグループ化して title fallback と message 順を維持する', async () => {
    const { readConversations } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      rows: [
        {
          conversationId: 'conversation-1',
          conversationTitle: null,
          conversationCreatedAt: new Date(),
          messageId: 'message-1',
          messageRole: 'system',
          messageContent: 'system',
          messageReasoningContent: '',
          messageMetadata: null,
          messageCreatedAt: new Date(),
        },
        {
          conversationId: 'conversation-1',
          conversationTitle: null,
          conversationCreatedAt: new Date(),
          messageId: 'message-2',
          messageRole: 'user',
          messageContent: 'hello',
          messageReasoningContent: 'thinking',
          messageMetadata: { foo: 'bar' },
          messageCreatedAt: new Date(),
        },
        {
          conversationId: 'conversation-2',
          conversationTitle: 'Second',
          conversationCreatedAt: new Date(),
          messageId: null,
          messageRole: null,
          messageContent: null,
          messageReasoningContent: null,
          messageMetadata: null,
          messageCreatedAt: null,
        },
      ],
    })

    await expect(readConversations('postgres://db', 'test@example.com')).resolves.toEqual([
      {
        id: 'conversation-1',
        title: 'Untitled Conversation',
        messages: [
          {
            id: 'message-1',
            role: 'system',
            content: 'system',
            reasoningContent: '',
            metadata: null,
          },
          {
            id: 'message-2',
            role: 'user',
            content: 'hello',
            reasoningContent: 'thinking',
            metadata: { foo: 'bar' },
          },
        ],
      },
      {
        id: 'conversation-2',
        title: 'Second',
        messages: [],
      },
    ])
  })
})
