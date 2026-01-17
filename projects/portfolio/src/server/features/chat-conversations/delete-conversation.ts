import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { UUID } from 'uuidv7'

// UUID検証用のヘルパー関数
function isValidUUID(id: string): boolean {
  try {
    UUID.parse(id)
    return true
  } catch {
    return false
  }
}

export async function deleteMessagesByIds(
  databaseUrl: string,
  email: string,
  messageIds: string[]
): Promise<{
  success: boolean
  deletedMessageIds: string[]
  failedMessageIds: string[]
  deletedConversationIds: string[]
}> {
  const db = getDatabase(databaseUrl)

  // 空の配列の場合は早期リターン
  if (messageIds.length === 0) {
    return {
      success: true,
      deletedMessageIds: [],
      failedMessageIds: [],
      deletedConversationIds: [],
    }
  }

  // UUID形式の検証
  const validIds: string[] = []
  const invalidIds: string[] = []

  for (const id of messageIds) {
    if (isValidUUID(id)) {
      validIds.push(id)
    } else {
      invalidIds.push(id)
    }
  }

  if (invalidIds.length > 0) {
    console.warn(`Warning: Invalid UUID format message IDs detected: ${invalidIds.join(', ')}`)
  }

  // 有効なIDがない場合は早期リターン
  if (validIds.length === 0) {
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }

  // ユーザーIDの取得
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    console.warn(`Warning: No users found with email: ${email}`)
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }
  const userId = users[0].id

  // 指定されたメッセージが該当ユーザーの所有する会話に属するかチェック
  const ownedMessages = await db
    .select({
      id: messagesTable.id,
      conversationId: messagesTable.conversationId,
    })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(messagesTable.conversationId, conversationsTable.id))
    .where(and(inArray(messagesTable.id, validIds), eq(conversationsTable.userId, userId)))

  const ownedMessageIds = ownedMessages.map((msg) => msg.id)
  const unauthorizedIds = messageIds.filter((id) => !ownedMessageIds.includes(id))

  if (unauthorizedIds.length > 0) {
    console.warn(
      `Warning: Some messages not found or access denied. Unauthorized IDs: ${unauthorizedIds.join(', ')}, Email: ${email}`
    )
  }

  // 削除可能なメッセージがない場合
  if (ownedMessageIds.length === 0) {
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }

  // 削除対象メッセージが属する会話IDを取得
  const affectedConversationIds = [...new Set(ownedMessages.map((msg) => msg.conversationId))]

  // トランザクション内で削除処理を実行
  try {
    const deletedConversationIds: string[] = []

    await db.transaction(async (tx) => {
      // 指定されたメッセージを削除
      await tx.delete(messagesTable).where(inArray(messagesTable.id, ownedMessageIds))

      // 各会話について、残りのメッセージがあるかチェック
      for (const conversationId of affectedConversationIds) {
        const remainingMessages = await tx
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversationId))
          .limit(1)

        // メッセージが残っていない場合、会話を削除
        if (remainingMessages.length === 0) {
          await tx.delete(conversationsTable).where(eq(conversationsTable.id, conversationId))

          deletedConversationIds.push(conversationId)
        }
      }
    })

    console.log(`Successfully deleted messages: ${ownedMessageIds.join(', ')}`)
    if (deletedConversationIds.length > 0) {
      console.log(`Successfully deleted orphaned conversations: ${deletedConversationIds.join(', ')}`)
    }

    return {
      success: true,
      deletedMessageIds: ownedMessageIds,
      failedMessageIds: unauthorizedIds,
      deletedConversationIds,
    }
  } catch (error) {
    console.error(`Error deleting messages ${ownedMessageIds.join(', ')}:`, error)
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }
}

export async function deleteConversations(
  databaseUrl: string,
  email: string,
  conversationIds: string[]
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
    .where(and(inArray(conversationsTable.id, conversationIds), eq(conversationsTable.userId, userId)))

  const ownedConversationIds = ownedConversations.map((conv) => conv.id)
  const unauthorizedIds = conversationIds.filter((id) => !ownedConversationIds.includes(id))

  if (unauthorizedIds.length > 0) {
    console.warn(
      `Warning: Some conversations not found or access denied. Unauthorized IDs: ${unauthorizedIds.join(', ')}, Email: ${email}`
    )
  }

  // 削除可能な会話がない場合
  if (ownedConversationIds.length === 0) {
    return { success: false, deletedIds: [], failedIds: conversationIds }
  }

  // トランザクション内で削除処理を実行
  try {
    await db.transaction(async (tx) => {
      // 関連するメッセージを削除
      await tx.delete(messagesTable).where(inArray(messagesTable.conversationId, ownedConversationIds))

      // 会話を削除
      await tx.delete(conversationsTable).where(inArray(conversationsTable.id, ownedConversationIds))
    })

    console.log(`Successfully deleted conversations: ${ownedConversationIds.join(', ')}`)
    return {
      success: true,
      deletedIds: ownedConversationIds,
      failedIds: unauthorizedIds,
    }
  } catch (error) {
    console.error(`Error deleting conversations ${ownedConversationIds.join(', ')}:`, error)
    return { success: false, deletedIds: [], failedIds: conversationIds }
  }
}
