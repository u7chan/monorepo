import { getDatabase } from '#/db'
import { conversationsTable, messagesTable, usersTable } from '#/db/schema'
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
    console.warn(`Warning: Invalid UUID format message IDs detected: ${invalidIds.join(', ')}`)
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
    console.warn(`Warning: No users found with email: ${email}`)
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
    console.warn(
      `Warning: Some messages not found or access denied. Unauthorized IDs: ${unauthorizedIds.join(', ')}, Email: ${email}`
    )
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
