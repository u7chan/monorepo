import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
import { logger } from '#/server/lib/logger'
import { and, eq, inArray } from 'drizzle-orm'
import { UUID } from 'uuidv7'

function isValidUUID(id: string): boolean {
  try {
    UUID.parse(id)
    return true
  } catch {
    return false
  }
}

export async function deleteMessages(
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

  if (messageIds.length === 0) {
    return {
      success: true,
      deletedMessageIds: [],
      failedMessageIds: [],
      deletedConversationIds: [],
    }
  }

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
    logger.warn({ invalidIds }, 'Invalid UUID format message IDs detected')
  }

  if (validIds.length === 0) {
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }

  const users = await db.select().from(usersTable).where(eq(usersTable.email, email))
  if (users.length <= 0) {
    logger.warn({ email }, 'No users found')
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }
  const userId = users[0].id

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
    logger.warn({ unauthorizedIds, email }, 'Messages not found or access denied')
  }

  if (ownedMessageIds.length === 0) {
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }

  const affectedConversationIds = [...new Set(ownedMessages.map((msg) => msg.conversationId))]

  try {
    const deletedConversationIds: string[] = []

    await db.transaction(async (tx) => {
      await tx.delete(messagesTable).where(inArray(messagesTable.id, ownedMessageIds))

      for (const conversationId of affectedConversationIds) {
        const remainingMessages = await tx
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversationId))
          .limit(1)

        if (remainingMessages.length === 0) {
          await tx.delete(conversationsTable).where(eq(conversationsTable.id, conversationId))
          deletedConversationIds.push(conversationId)
        }
      }
    })

    logger.info({ deletedIds: ownedMessageIds }, 'Messages deleted')
    if (deletedConversationIds.length > 0) {
      logger.info({ deletedConversationIds }, 'Orphaned conversations deleted')
    }

    return {
      success: true,
      deletedMessageIds: ownedMessageIds,
      failedMessageIds: unauthorizedIds,
      deletedConversationIds,
    }
  } catch (error) {
    logger.error({ err: error, messageIds: ownedMessageIds }, 'Failed to delete messages')
    return {
      success: false,
      deletedMessageIds: [],
      failedMessageIds: messageIds,
      deletedConversationIds: [],
    }
  }
}
