import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
import type { Conversation } from '#/types'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

/**
 * content を DB 保存用に serialize する。
 * 文字列の場合はそのまま、配列の場合は JSON 文字列に変換する。
 */
function serializeContent(content: string | unknown[]): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

export async function upsertConversation(databaseUrl: string, email: string, { id, title, messages }: Conversation) {
  const db = getDatabase(databaseUrl)

  // ユーザーIDの取得
  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    console.warn(`Warning: No users found with email: ${email}`)
    return null
  }
  const userId = users[0].id

  return await db.transaction(async (tx) => {
    // 会話がすでに存在するかチェック
    const existingConversations = await tx.select().from(conversationsTable).where(eq(conversationsTable.id, id))

    const now = new Date()

    if (existingConversations.length === 0) {
      // 存在しなければ会話を登録
      await tx.insert(conversationsTable).values({
        id,
        userId,
        title,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      // 存在すれば会話のupdatedAtを更新
      await tx.update(conversationsTable).set({ updatedAt: now }).where(eq(conversationsTable.id, id))
      // 既存メッセージを削除（全件再挿入による重複を防ぐ）
      await tx.delete(messagesTable).where(eq(messagesTable.conversationId, id))
    }

    // メッセージの登録（全件挿入）
    const messageValues = messages.map((message) => ({
      id: uuidv7(),
      conversationId: id,
      role: message.role,
      content: serializeContent(message.content),
      reasoningContent: message.reasoningContent ?? '',
      metadata: message.metadata ?? {},
      createdAt: now,
    }))

    await tx.insert(messagesTable).values(messageValues)
  })
}
