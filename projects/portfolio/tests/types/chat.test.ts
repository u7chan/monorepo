import { ConversationListResponseSchema } from '#/types'
import { describe, expect, it } from 'vitest'

describe('chat types', () => {
  it('updatedAt を含む会話一覧レスポンスを正規化できる', () => {
    const response = ConversationListResponseSchema.parse({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          updatedAt: '2026-04-14T12:34:56.000Z',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'hello',
              reasoningContent: '',
              metadata: {},
            },
            {
              id: 'message-2',
              role: 'assistant',
              content: 'world',
              reasoningContent: '',
              metadata: {},
            },
          ],
        },
      ],
    })

    expect(response).toEqual({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          updatedAt: new Date('2026-04-14T12:34:56.000Z'),
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'hello',
              reasoningContent: '',
              metadata: {
                model: '',
              },
            },
            {
              id: 'message-2',
              role: 'assistant',
              content: 'world',
              reasoningContent: '',
              metadata: {
                model: '',
                usage: {},
              },
            },
          ],
        },
      ],
    })
  })

  it('updatedAt が無い既存レスポンスも正規化できる', () => {
    const response = ConversationListResponseSchema.parse({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          messages: [],
        },
      ],
    })

    expect(response).toEqual({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
          messages: [],
        },
      ],
    })
  })
})
