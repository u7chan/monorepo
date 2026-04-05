import type { Conversation } from '#/types'

export const createConversationFixture = (): Conversation => ({
  id: 'conversation-1',
  title: 'Fixture Conversation',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'hello',
      reasoningContent: '',
      metadata: {
        model: 'gpt-test',
      },
    },
  ],
})
