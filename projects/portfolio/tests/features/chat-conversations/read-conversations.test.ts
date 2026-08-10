import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../../helpers/mock-logger'

const importSubject = async (params: {
  users: Array<{ id: string; email: string }>
  rows: Array<Record<string, unknown>>
}) => {
  mockLogger()
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
    const firstConversationUpdatedAt = new Date('2026-04-14T12:34:56.000Z')
    const secondConversationUpdatedAt = new Date('2026-04-13T10:00:00.000Z')

    const { readConversations } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      rows: [
        {
          conversationId: 'conversation-1',
          conversationTitle: null,
          conversationCreatedAt: new Date(),
          conversationUpdatedAt: firstConversationUpdatedAt,
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
          conversationUpdatedAt: firstConversationUpdatedAt,
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
          conversationUpdatedAt: secondConversationUpdatedAt,
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
        updatedAt: firstConversationUpdatedAt,
        messages: [
          {
            id: 'message-1',
            role: 'system',
            content: 'system',
            // reasoningContent が空文字列の場合は undefined
            reasoningContent: undefined,
            // metadata が null の場合は undefined（SystemMessage.metadata は optional）
            metadata: undefined,
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
        updatedAt: secondConversationUpdatedAt,
        messages: [],
      },
    ])
  })

  it('配列 content（JSON 文字列）を deserialize して配列に戻す', async () => {
    const { readConversations } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      rows: [
        {
          conversationId: 'conversation-1',
          conversationTitle: 'Test',
          conversationCreatedAt: new Date(),
          conversationUpdatedAt: new Date('2026-04-14T12:34:56.000Z'),
          messageId: 'message-1',
          messageRole: 'user',
          // 配列 content が JSON 文字列として保存されている
          messageContent: JSON.stringify([
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
          ]),
          messageReasoningContent: '',
          messageMetadata: { model: 'gpt-test' },
          messageCreatedAt: new Date(),
        },
      ],
    })

    const result = await readConversations('postgres://db', 'test@example.com')
    expect(result?.[0].messages[0].content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
    ])
  })

  it('legacy: metadata が文字列化 JSON の場合はパースして返す', async () => {
    const { readConversations } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      rows: [
        {
          conversationId: 'conversation-1',
          conversationTitle: 'Test',
          conversationCreatedAt: new Date(),
          conversationUpdatedAt: new Date('2026-04-14T12:34:56.000Z'),
          messageId: 'message-1',
          messageRole: 'user',
          messageContent: 'hello',
          messageReasoningContent: '',
          // legacy: metadata が JSON 文字列として格納されているケース
          messageMetadata: JSON.stringify({ model: 'gpt-test', stream: true }),
          messageCreatedAt: new Date(),
        },
      ],
    })

    const result = await readConversations('postgres://db', 'test@example.com')
    expect(result?.[0].messages[0].metadata).toEqual({ model: 'gpt-test', stream: true })
  })

  it('assistant generatedFiles の previewUrl を公開 URL で補正する', async () => {
    const { readConversations } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      rows: [
        {
          conversationId: 'conversation-1',
          conversationTitle: 'Test',
          conversationCreatedAt: new Date(),
          conversationUpdatedAt: new Date('2026-04-14T12:34:56.000Z'),
          messageId: 'message-1',
          messageRole: 'assistant',
          messageContent: '<div>Hello</div>',
          messageReasoningContent: '',
          messageMetadata: {
            model: 'gpt-test',
            usage: {},
            generatedFiles: [
              {
                blockIndex: 0,
                language: 'html',
                fileName: 'message-1-block-0.html',
                publicPath: '/public/portfolio/c1/message-1-block-0.html',
                previewUrl: 'http://file-server:3000/public/portfolio/c1/message-1-block-0.html',
                contentType: 'text/html; charset=utf-8',
                createdAt: '2026-04-19T00:00:00.000Z',
              },
            ],
          },
          messageCreatedAt: new Date(),
        },
      ],
    })

    const result = await readConversations('postgres://db', 'test@example.com', 'http://files.example.com')
    const message = result?.[0].messages[0]

    expect(message?.role).toBe('assistant')
    if (message?.role === 'assistant') {
      expect(message.metadata.generatedFiles).toEqual([
        expect.objectContaining({
          publicPath: '/public/portfolio/c1/message-1-block-0.html',
          previewUrl: 'http://files.example.com/public/portfolio/c1/message-1-block-0.html',
        }),
      ])
    }
  })

  it('画像 assistant の responseTimeMs を再読込時も保持する', async () => {
    const { readConversations } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      rows: [
        {
          conversationId: 'conversation-1',
          conversationTitle: '画像生成',
          conversationCreatedAt: new Date(),
          conversationUpdatedAt: new Date('2026-08-10T00:00:00.000Z'),
          messageId: 'assistant-1',
          messageRole: 'assistant',
          messageContent: '',
          messageReasoningContent: '',
          messageMetadata: {
            model: 'gpt-image-2',
            responseTimeMs: 1_345,
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            generatedImages: [
              {
                fileName: 'image-1.png',
                publicPath: '/public/portfolio/conversation-1/image-1.png',
                previewUrl: 'http://internal-file-server/public/portfolio/conversation-1/image-1.png',
                contentType: 'image/png',
                createdAt: '2026-08-10T00:00:00.000Z',
              },
            ],
          },
          messageCreatedAt: new Date(),
        },
      ],
    })

    const result = await readConversations('postgres://db', 'test@example.com', 'https://files.example.com')
    const message = result?.[0].messages[0]

    expect(message?.role).toBe('assistant')
    if (message?.role === 'assistant') {
      expect(message.metadata.responseTimeMs).toBe(1_345)
      expect(message.metadata.generatedImages?.[0]).toMatchObject({
        publicPath: '/public/portfolio/conversation-1/image-1.png',
        previewUrl: 'https://files.example.com/public/portfolio/conversation-1/image-1.png',
      })
    }
  })
})
