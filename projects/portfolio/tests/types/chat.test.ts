import { ConversationListResponseSchema } from '#/types'
import { describe, expect, it } from 'vitest'

describe('chat types', () => {
  it('legacy metadata を含む会話一覧レスポンスを正規化できる', () => {
    const response = ConversationListResponseSchema.parse({
      data: [
        {
          id: 'conversation-1',
          title: 'Legacy conversation',
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
})
