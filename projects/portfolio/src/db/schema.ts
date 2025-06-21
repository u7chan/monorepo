import { relations } from 'drizzle-orm'
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// ユーザー
export const usersTable = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),
})

// 会話
export const conversationsTable = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => usersTable.id),
  title: text('title'),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull(),
})

// メッセージ
export const messagesTable = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversationsTable.id),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  reasoningContent: text('reasoning_content').notNull(),
  metadata: jsonb('metadata'), // JSONデータ型
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),
})

// リレーション
export const usersRelations = relations(usersTable, ({ many }) => ({
  conversations: many(conversationsTable),
}))

export const conversationsRelations = relations(conversationsTable, ({ one, many }) => ({
  user: one(usersTable, { fields: [conversationsTable.userId], references: [usersTable.id] }),
  messages: many(messagesTable),
}))

export const messagesRelations = relations(messagesTable, ({ one }) => ({
  conversation: one(conversationsTable, {
    fields: [messagesTable.conversationId],
    references: [conversationsTable.id],
  }),
}))
