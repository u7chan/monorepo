import { deleteConversation } from '#/server/features/chat-conversations/delete-conversation'
import { readConversation } from '#/server/features/chat-conversations/read-conversation'
import { upsertConversation } from '#/server/features/chat-conversations/upsert-conversation'
import type { Conversation } from '#/types'

interface ChatConversationRepository {
  read(databaseUrl: string, email: string): Promise<Conversation[] | null>
  upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void>
  delete(databaseUrl: string, email: string, conversationId: string): Promise<boolean>
}

export const chatConversationRepository: ChatConversationRepository = {
  async read(databaseUrl: string, email: string): Promise<Conversation[] | null> {
    return readConversation(databaseUrl, email)
  },
  async upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void> {
    await upsertConversation(databaseUrl, email, conversation)
  },
  async delete(databaseUrl: string, email: string, conversationId: string): Promise<boolean> {
    return deleteConversation(databaseUrl, email, conversationId)
  },
}
