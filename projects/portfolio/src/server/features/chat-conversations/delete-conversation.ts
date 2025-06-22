import { and, eq, inArray } from 'drizzle-orm'
import { UUID } from 'uuidv7'

import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'

// UUID検証用のヘルパー関数
function isValidUUID(id: string): boolean {
  try {
    UUID.parse(id)
    return true
  } catch {
    return false
  }
}

export async function deleteConversations(
  databaseUrl: string,
  email: string,
  conversationIds: string[],
): Promise<{ success: boolean; deletedIds: string[]; failedIds: string[] }> {
  const db = getDatabase(databaseUrl)

  // 空の配列の場合は早期リターン
  if (conversationIds.length === 0) {
    return { success: true, deletedIds: [], failedIds: [] }
  }

  // UUID形式の検証
  const validIds: string[] = []
  const invalidIds: string[] = []

  for (const id of conversationIds) {
    if (isValidUUID(id)) {
      validIds.push(id)
    } else {
      invalidIds.push(id)
    }
  }

  if (invalidIds.length > 0) {
    console.warn(`Warning: Invalid UUID format IDs detected: ${invalidIds.join(', ')}`)
  }

  // 有効なIDがない場合は早期リターン
  if (validIds.length === 0) {
    return { success: false, deletedIds: [], failedIds: conversationIds }
  }

  // ユーザーIDの取得
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    console.warn(`Warning: No users found with email: ${email}`)
    return { success: false, deletedIds: [], failedIds: conversationIds }
  }
  const userId = users[0].id

  // 指定された会話が該当ユーザーの所有かチェック
  const ownedConversations = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        inArray(conversationsTable.id, conversationIds),
        eq(conversationsTable.userId, userId)
      )
    )

  const ownedConversationIds = ownedConversations.map(conv => conv.id)
  const unauthorizedIds = conversationIds.filter(id => !ownedConversationIds.includes(id))

  if (unauthorizedIds.length > 0) {
    console.warn(`Warning: Some conversations not found or access denied. Unauthorized IDs: ${unauthorizedIds.join(', ')}, Email: ${email}`)
  }

  // 削除可能な会話がない場合
  if (ownedConversationIds.length === 0) {
    return { success: false, deletedIds: [], failedIds: conversationIds }
  }

  // トランザクション内で削除処理を実行
  try {
    await db.transaction(async (tx) => {
      // 関連するメッセージを削除
      await tx
        .delete(messagesTable)
        .where(inArray(messagesTable.conversationId, ownedConversationIds))

      // 会話を削除
      await tx
        .delete(conversationsTable)
        .where(inArray(conversationsTable.id, ownedConversationIds))
    })

    console.log(`Successfully deleted conversations: ${ownedConversationIds.join(', ')}`)
    return {
      success: true,
      deletedIds: ownedConversationIds,
      failedIds: unauthorizedIds
    }
  } catch (error) {
    console.error(`Error deleting conversations ${ownedConversationIds.join(', ')}:`, error)
    return { success: false, deletedIds: [], failedIds: conversationIds }
  }
}
