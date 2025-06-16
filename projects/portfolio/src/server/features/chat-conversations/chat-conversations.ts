import { createConversation } from '#/server/features/chat-conversations/create-conversation'

export type MutableChatMessage = {
  content: string
  reasoning_content: string
  model: string
  finish_reason: string
  completion_tokens?: number
  prompt_tokens?: number
  total_tokens?: number
  reasoning_tokens?: number
}

export type ChatMessage = Readonly<MutableChatMessage>

interface ChatConversationRepository {
  save(databaseUrl: string, chatMessage: ChatMessage): Promise<void>
}

export const chatConversationRepository: ChatConversationRepository = {
  async save(databaseUrl: string, chatMessage: ChatMessage): Promise<void> {
    // await createConversation(databaseUrl, {
    //   userId: '',
    //   title: 'untitled',
    //   messages: [],
    // })
  },
}
