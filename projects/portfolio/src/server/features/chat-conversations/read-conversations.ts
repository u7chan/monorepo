import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
import type { AssistantMetadata, Conversation, ImageContent, Message, TextContent, UserMetadata } from '#/types'
import { asc, desc, eq } from 'drizzle-orm'

/**
 * DB から読み出した content 文字列を deserialize する。
 * 配列として保存されている場合（先頭が "[" ）は JSON.parse して配列に戻す。
 * legacy データや通常の文字列はそのまま返す。
 */
function deserializeContent(value: string): string | Array<TextContent | ImageContent> {
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return parsed as Array<TextContent | ImageContent>
      }
    } catch {
      // パース失敗は文字列として扱う
    }
  }
  return value
}

/**
 * DB から読み出した metadata を deserialize する。
 * jsonb カラムだが、legacy データとして JSON 文字列が入っている場合に対応。
 */
function deserializeMetadata(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

export async function readConversations(databaseUrl: string, email: string): Promise<Conversation[] | null> {
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
      conversationUpdatedAt: conversationsTable.updatedAt,
      messageId: messagesTable.id,
      messageRole: messagesTable.role,
      messageContent: messagesTable.content,
      messageReasoningContent: messagesTable.reasoningContent,
      messageMetadata: messagesTable.metadata,
      messageCreatedAt: messagesTable.createdAt,
    })
    .from(conversationsTable)
    .leftJoin(messagesTable, eq(conversationsTable.id, messagesTable.conversationId))
    .where(eq(conversationsTable.userId, userId))
    .orderBy(desc(conversationsTable.updatedAt), asc(messagesTable.createdAt))

  // JOINの結果を会話ごとにグループ化
  const conversationMap = new Map<string, Conversation>()

  for (const row of conversationsWithMessages) {
    if (!conversationMap.has(row.conversationId)) {
      conversationMap.set(row.conversationId, {
        id: row.conversationId,
        title: row.conversationTitle || 'Untitled Conversation',
        updatedAt: row.conversationUpdatedAt,
        messages: [],
      })
    }

    // メッセージが存在する場合のみ追加（LEFT JOINでメッセージがない会話も含まれるため）
    if (row.messageRole && row.messageContent !== null && row.messageReasoningContent !== null) {
      const conversation = conversationMap.get(row.conversationId)
      if (conversation) {
        const message = buildMessage({
          id: row.messageId ?? '',
          role: row.messageRole,
          content: row.messageContent,
          reasoningContent: row.messageReasoningContent,
          metadata: deserializeMetadata(row.messageMetadata),
        })
        if (message) {
          conversation.messages.push(message)
        }
      }
    }
  }

  return Array.from(conversationMap.values())
}

/**
 * DB 行からドメイン Message を構築する。
 * role ごとに分岐して discriminated union を満たす。
 */
function buildMessage(row: {
  id: string
  role: string
  content: string
  reasoningContent: string
  metadata: unknown
}): Message | null {
  const content = deserializeContent(row.content)

  if (row.role === 'user') {
    return {
      id: row.id,
      role: 'user',
      content,
      reasoningContent: row.reasoningContent,
      metadata: (row.metadata ?? {}) as UserMetadata,
    }
  }

  if (row.role === 'assistant') {
    return {
      id: row.id,
      role: 'assistant',
      content: typeof content === 'string' ? content : '',
      reasoningContent: row.reasoningContent || undefined,
      metadata: (row.metadata ?? {}) as AssistantMetadata,
    }
  }

  if (row.role === 'system') {
    return {
      id: row.id,
      role: 'system',
      content: typeof content === 'string' ? content : '',
      reasoningContent: row.reasoningContent,
      metadata: (row.metadata as Record<string, never> | undefined) ?? undefined,
    }
  }

  return null
}
