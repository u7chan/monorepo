import {
  deleteConversations,
  deleteMessagesByIds,
} from '#/server/features/chat-conversations/delete-conversation'
import { readConversation } from '#/server/features/chat-conversations/read-conversation'
import { upsertConversation } from '#/server/features/chat-conversations/upsert-conversation'
import type { Conversation } from '#/types'

interface ChatConversationRepository {
  read(databaseUrl: string, email: string): Promise<Conversation[] | null>
  upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void>
  delete(
    databaseUrl: string,
    email: string,
    conversationIds: string[],
  ): Promise<{ success: boolean; deletedIds: string[]; failedIds: string[] }>
  deleteMessages(
    databaseUrl: string,
    email: string,
    messageIds: string[],
  ): Promise<{
    success: boolean
    deletedMessageIds: string[]
    failedMessageIds: string[]
    deletedConversationIds: string[]
  }>
}

export const chatConversationRepository: ChatConversationRepository = {
  async read(databaseUrl: string, email: string): Promise<Conversation[] | null> {
    return readConversation(databaseUrl, email)
  },
  async upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void> {
    await upsertConversation(databaseUrl, email, conversation)
  },
  async delete(
    databaseUrl: string,
    email: string,
    conversationIds: string[],
  ): Promise<{ success: boolean; deletedIds: string[]; failedIds: string[] }> {
    return deleteConversations(databaseUrl, email, conversationIds)
  },
  async deleteMessages(
    databaseUrl: string,
    email: string,
    messageIds: string[],
  ): Promise<{
    success: boolean
    deletedMessageIds: string[]
    failedMessageIds: string[]
    deletedConversationIds: string[]
  }> {
    return deleteMessagesByIds(databaseUrl, email, messageIds)
  },
}
