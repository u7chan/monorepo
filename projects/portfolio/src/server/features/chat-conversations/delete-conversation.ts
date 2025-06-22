import { and, eq } from 'drizzle-orm'

import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'

export async function deleteConversation(
  databaseUrl: string,
  email: string,
  conversationId: string,
): Promise<boolean> {
  const db = getDatabase(databaseUrl)

  // ユーザーIDの取得
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    console.warn(`Warning: No users found with email: ${email}`)
    return false
  }
  const userId = users[0].id

  // 指定された会話が該当ユーザーの所有かチェック
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.userId, userId)))

  if (conversations.length === 0) {
    console.warn(
      `Warning: Conversation not found or access denied. ConversationId: ${conversationId}, Email: ${email}`,
    )
    return false
  }

  // トランザクション内で削除処理を実行
  try {
    await db.transaction(async (tx) => {
      // 関連するメッセージを削除
      await tx.delete(messagesTable).where(eq(messagesTable.conversationId, conversationId))

      // 会話を削除
      await tx.delete(conversationsTable).where(eq(conversationsTable.id, conversationId))
    })

    console.log(`Successfully deleted conversation: ${conversationId}`)
    return true
  } catch (error) {
    console.error(`Error deleting conversation ${conversationId}:`, error)
    return false
  }
}
