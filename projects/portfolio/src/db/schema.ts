import { relations } from 'drizzle-orm'
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// ユーザー
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),
})

// 会話
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  title: text('title'),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),
})

// メッセージ
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  reasoningContent: text('reasoning_content').notNull(),
  metadata: jsonb('metadata'), // JSONデータ型
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(),
})

// リレーション
export const usersRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
}))

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}))
