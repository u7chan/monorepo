export type MutableChatConversation = {
  content: string
  reasoning_content: string
  model: string
  finish_reason: string
  completion_tokens?: number
  prompt_tokens?: number
  total_tokens?: number
  reasoning_tokens?: number
}

export type ChatConversation = Readonly<MutableChatConversation>

interface ChatConversationRepository {
  save(chatConversation: ChatConversation): Promise<void>
}

export const chatConversationRepository: ChatConversationRepository = {
  async save(chatConversation: ChatConversation): Promise<void> {
    // TODO:
    console.log('save:', JSON.stringify(chatConversation))
  },
}
