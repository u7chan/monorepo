import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
import { logger } from '#/server/lib/logger'
import type { AssistantMetadata } from '#/types'
import { and, eq } from 'drizzle-orm'

export type UpdateMessageMetadataResult =
  | { ok: true; metadata: AssistantMetadata }
  | { ok: false; reason: 'user-not-found' | 'message-not-found' | 'forbidden' | 'invalid-role' }

function deserializeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>
  }
  return {}
}

/**
 * assistant message の metadata を部分更新する。
 * 既存 metadata と shallow merge して保存し、
 * 保存後の完全な metadata を返す。
 */
export async function updateMessageMetadata(
  databaseUrl: string,
  email: string,
  params: {
    conversationId: string
    messageId: string
    metadataPatch: Partial<AssistantMetadata>
  }
): Promise<UpdateMessageMetadataResult> {
  const db = getDatabase(databaseUrl)

  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    logger.warn({ email }, 'No users found')
    return { ok: false, reason: 'user-not-found' }
  }
  const userId = users[0].id

  const rows = await db
    .select({
      messageId: messagesTable.id,
      role: messagesTable.role,
      metadata: messagesTable.metadata,
      conversationUserId: conversationsTable.userId,
    })
    .from(messagesTable)
    .innerJoin(conversationsTable, eq(messagesTable.conversationId, conversationsTable.id))
    .where(and(eq(messagesTable.id, params.messageId), eq(messagesTable.conversationId, params.conversationId)))

  if (rows.length === 0) {
    return { ok: false, reason: 'message-not-found' }
  }

  const row = rows[0]
  if (row.conversationUserId !== userId) {
    return { ok: false, reason: 'forbidden' }
  }
  if (row.role !== 'assistant') {
    return { ok: false, reason: 'invalid-role' }
  }

  const existing = deserializeMetadata(row.metadata)
  const merged = { ...existing, ...params.metadataPatch } as Record<string, unknown>

  await db.update(messagesTable).set({ metadata: merged }).where(eq(messagesTable.id, params.messageId))

  return { ok: true, metadata: merged as AssistantMetadata }
}
