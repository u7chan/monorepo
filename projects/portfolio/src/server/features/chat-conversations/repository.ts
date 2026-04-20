import { deleteConversations } from '#/server/features/chat-conversations/delete-conversations'
import { deleteMessages } from '#/server/features/chat-conversations/delete-messages'
import type { FileServerConfig } from '#/server/features/chat-conversations/file-server-client'
import { readConversations } from '#/server/features/chat-conversations/read-conversations'
import {
  saveGeneratedFile,
  type SaveGeneratedFileResult,
} from '#/server/features/chat-conversations/save-generated-file'
import {
  updateMessageMetadata,
  type UpdateMessageMetadataResult,
} from '#/server/features/chat-conversations/update-message-metadata'
import { upsertConversation } from '#/server/features/chat-conversations/upsert-conversation'
import type { AssistantMetadata, Conversation } from '#/types'

interface ChatConversationRepository {
  read(databaseUrl: string, email: string, fileServerPublicBaseUrl?: string | null): Promise<Conversation[] | null>
  upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void>
  delete(
    databaseUrl: string,
    email: string,
    conversationIds: string[]
  ): Promise<{ success: boolean; deletedIds: string[]; failedIds: string[] }>
  deleteMessages(
    databaseUrl: string,
    email: string,
    messageIds: string[]
  ): Promise<{
    success: boolean
    deletedMessageIds: string[]
    failedMessageIds: string[]
    deletedConversationIds: string[]
  }>
  updateMessageMetadata(
    databaseUrl: string,
    email: string,
    params: {
      conversationId: string
      messageId: string
      metadataPatch: Partial<AssistantMetadata>
    }
  ): Promise<UpdateMessageMetadataResult>
  saveGeneratedFile(
    databaseUrl: string,
    email: string,
    params: {
      conversationId: string
      messageId: string
      blockIndex: number
      language: string
      content: string
    },
    fileServerConfig: FileServerConfig | null
  ): Promise<SaveGeneratedFileResult>
}

export const chatConversationRepository: ChatConversationRepository = {
  async read(
    databaseUrl: string,
    email: string,
    fileServerPublicBaseUrl?: string | null
  ): Promise<Conversation[] | null> {
    return readConversations(databaseUrl, email, fileServerPublicBaseUrl)
  },
  async upsert(databaseUrl: string, email: string, conversation: Conversation): Promise<void> {
    await upsertConversation(databaseUrl, email, conversation)
  },
  async delete(
    databaseUrl: string,
    email: string,
    conversationIds: string[]
  ): Promise<{ success: boolean; deletedIds: string[]; failedIds: string[] }> {
    return deleteConversations(databaseUrl, email, conversationIds)
  },
  async deleteMessages(
    databaseUrl: string,
    email: string,
    messageIds: string[]
  ): Promise<{
    success: boolean
    deletedMessageIds: string[]
    failedMessageIds: string[]
    deletedConversationIds: string[]
  }> {
    return deleteMessages(databaseUrl, email, messageIds)
  },
  async updateMessageMetadata(databaseUrl, email, params) {
    return updateMessageMetadata(databaseUrl, email, params)
  },
  async saveGeneratedFile(databaseUrl, email, params, fileServerConfig) {
    return saveGeneratedFile(databaseUrl, email, params, fileServerConfig)
  },
}
