import type { Conversation as ClientConversation } from '#/client/components/chat/ConversationHistory'
import { upsertConversation } from '#/server/features/chat-conversations/upsert-conversation'
import type { Conversation } from '#/types'

interface ChatConversationRepository {
  read(databaseUrl: string, email: string): Promise<ClientConversation[] | null>
  upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void>
}

export const chatConversationRepository: ChatConversationRepository = {
  async read(_databaseUrl: string, _email: string): Promise<ClientConversation[] | null> {
    return []
    // return readConversation(databaseUrl, email)
  },
  async upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void> {
    const userContent = conversation.messages.find((x) => x.role === 'user')?.content || ''
    await upsertConversation(databaseUrl, {
      email,
      conversationId: conversation.id,
      title: userContent.slice(10),
      messages: conversation.messages.map(({ role, content, reasoningContent, metadata }) => ({
        role,
        content,
        reasoningContent,
        metadata,
      })),
    })
  },
}
