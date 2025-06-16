import { randomUUID } from 'node:crypto'

import { getDatabase } from '#/db'
import { conversationsTable, messagesTable } from '#/db/schema'

type CreateConversationParams = {
  userId: string
  title?: string
  messages: {
    role: 'user' | 'assistant'
    content: string
    reasoningContent: string
    metadata?: Record<string, unknown>
  }[]
}

export async function createConversation(
  databaseUrl: string,
  { userId, title, messages }: CreateConversationParams,
) {
  const db = getDatabase(databaseUrl)

  const conversationId = `${randomUUID()}`
  const createdAt = new Date()

  return await db.transaction(async (tx) => {
    // 会話の登録
    await tx.insert(conversationsTable).values({
      id: conversationId,
      userId,
      title,
      createdAt,
    })

    // メッセージの登録
    const messageValues = messages.map((message) => ({
      id: `${randomUUID()}`,
      conversationId,
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      metadata: message.metadata ? JSON.stringify(message.metadata) : null,
      createdAt,
    }))

    await tx.insert(messagesTable).values(messageValues)

    return { conversationId }
  })
}
