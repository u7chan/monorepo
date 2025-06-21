import { desc, eq, sql } from 'drizzle-orm'

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

  // 会話とメッセージを一括取得（JOINを使用してN+1問題を解決）
  const conversationsWithMessages = await db
    .select({
      conversationId: conversationsTable.id,
      conversationTitle: conversationsTable.title,
      conversationCreatedAt: conversationsTable.createdAt,
      messageRole: messagesTable.role,
      messageContent: messagesTable.content,
      messageReasoningContent: messagesTable.reasoningContent,
      messageMetadata: messagesTable.metadata,
      messageCreatedAt: messagesTable.createdAt,
    })
    .from(conversationsTable)
    .leftJoin(messagesTable, eq(conversationsTable.id, messagesTable.conversationId))
    .where(eq(conversationsTable.userId, userId))
    .orderBy(
      desc(conversationsTable.createdAt),
      desc(messagesTable.createdAt),
      sql`CASE
        WHEN ${messagesTable.role} = 'system' THEN 1
        WHEN ${messagesTable.role} = 'user' THEN 2
        WHEN ${messagesTable.role} = 'assistant' THEN 3
        ELSE 4
      END`
    )

  // JOINの結果を会話ごとにグループ化
  const conversationMap = new Map<string, Conversation>()

  for (const row of conversationsWithMessages) {
    if (!conversationMap.has(row.conversationId)) {
      conversationMap.set(row.conversationId, {
        id: row.conversationId,
        title: row.conversationTitle || 'Untitled Conversation',
        messages: []
      })
    }

    // メッセージが存在する場合のみ追加（LEFT JOINでメッセージがない会話も含まれるため）
    if (row.messageRole && row.messageContent !== null && row.messageReasoningContent !== null) {
      const conversation = conversationMap.get(row.conversationId)
      if (conversation) {
        conversation.messages.push({
          role: row.messageRole as never,
          content: row.messageContent,
          reasoningContent: row.messageReasoningContent,
          metadata: row.messageMetadata as never,
        })
      }
    }
  }

  return Array.from(conversationMap.values())
}
