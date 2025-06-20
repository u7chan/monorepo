import type { Conversation } from '#/client/components/chat/ConversationHistory'
import { createConversation } from '#/server/features/chat-conversations/create-conversation'
import { readConversation } from '#/server/features/chat-conversations/read-conversation'

export type MutableChatMessage = {
  content: string
  reasoning_content?: string
  metadata: {
    model: string
    // request
    stream?: boolean
    temperature?: number
    max_tokens?: number
    // response
    finish_reason?: string
    completion_tokens?: number
    prompt_tokens?: number
    total_tokens?: number
    reasoning_tokens?: number
  }
}

export type ChatMessage = Readonly<MutableChatMessage>

interface ChatConversationRepository {
  read(databaseUrl: string, email: string): Promise<Conversation[] | null>
  save(
    databaseUrl: string,
    email: string,
    conversationId: string,
    messages: { user: ChatMessage; assistant: ChatMessage },
  ): Promise<void>
}

export const chatConversationRepository: ChatConversationRepository = {
  async read(databaseUrl: string, email: string): Promise<Conversation[] | null> {
    if (!email) {
      return null
    }
    return readConversation(databaseUrl, email)
  },
  async save(
    databaseUrl: string,
    email: string,
    conversationId: string,
    { user, assistant }: { user: ChatMessage; assistant: ChatMessage },
  ): Promise<void> {
    if (!email) {
      return
    }
    await createConversation(databaseUrl, {
      email,
      conversationId,
      title: `${user.content.slice(10)}...`,
      messages: [
        {
          role: 'user',
          content: user.content,
          reasoningContent: '',
          metadata: user.metadata,
        },
        {
          role: 'assistant',
          content: assistant.content,
          reasoningContent: assistant.reasoning_content || '',
          metadata: assistant.metadata,
        },
      ],
    })
  },
}
