import { desc, eq } from 'drizzle-orm'

import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
import type { Conversation } from '#/types'

export async function readConversation(
  databaseUrl: string,
  email: string,
): Promise<Conversation[] | null> {
  const db = getDatabase(databaseUrl)

  // ユーザーIDの取得
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    console.warn(`Warning: No users found with email: ${email}`)
    return null
  }
  const userId = users[0].id

  // 会話一覧を最新順で取得
  const conversations = await db
    .select({
      id: conversationsTable.id,
      title: conversationsTable.title,
      createdAt: conversationsTable.createdAt,
    })
    .from(conversationsTable)
    .where(eq(conversationsTable.userId, userId))
    .orderBy(desc(conversationsTable.createdAt))

  // 各会話のメッセージを取得
  const conversationsWithMessages: Conversation[] = []

  for (const conversation of conversations) {
    const messages = await db
      .select({
        role: messagesTable.role,
        content: messagesTable.content,
        reasoningContent: messagesTable.reasoningContent,
        metadata: messagesTable.metadata,
        createdAt: messagesTable.createdAt,
      })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversation.id))
      .orderBy(messagesTable.createdAt) // メッセージは時系列順

    conversationsWithMessages.push({
      id: conversation.id,
      title: conversation.title || 'Untitled Conversation',
      messages: messages.map((message) => ({
        role: message.role as never,
        content: message.content,
        reasoningContent: message.reasoningContent,
        metadata: message.metadata as never
      })),
    })
  }

  return conversationsWithMessages
}
