import { eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'

import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'

type CreateConversationParams = {
  email: string
  conversationId: string
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
  { email, conversationId, title, messages }: CreateConversationParams,
) {
  const db = getDatabase(databaseUrl)

  // ユーザーIDの取得
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    console.warn(`Warning: No users found with email: ${email}`)
    return null
  }
  const userId = users[0].id
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
      id: uuidv4(),
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
