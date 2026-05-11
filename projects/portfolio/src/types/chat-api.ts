import { z } from 'zod'
import { ApiChatMessageSchema, ApiModeSchema, ConversationSchema, ReasoningEffortSchema } from './chat'

// ============================================
// /api/chat, /api/chat/stream 公開コントラクト
// ============================================

/** /api/chat, /api/chat/stream 共通リクエストスキーマ */
export const ChatApiRequestSchema = z.object({
  messages: ApiChatMessageSchema.array(),
  model: z.string().min(1),
  apiMode: ApiModeSchema.optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
})

export type ChatApiRequest = z.infer<typeof ChatApiRequestSchema>

// ============================================
// Usage
// ============================================

export const ChatUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().optional(),
})

export type ChatUsage = z.infer<typeof ChatUsageSchema>

// ============================================
// 非ストリームレスポンス
// ============================================

export const ChatResponseSchema = z.object({
  id: z.string(),
  created: z.number(),
  model: z.string(),
  finishReason: z.string(),
  message: z.object({
    content: z.string(),
    reasoningContent: z.string(),
  }),
  usage: ChatUsageSchema.nullable(),
})

export type ChatResponse = z.infer<typeof ChatResponseSchema>

// ============================================
// SSE ストリームイベント (discriminated union)
// ============================================

export const ChatStreamDeltaEventSchema = z.object({
  event: z.literal('delta'),
  id: z.string(),
  created: z.number(),
  model: z.string(),
  content: z.string().optional(),
  reasoningContent: z.string().optional(),
})

export type ChatStreamDeltaEvent = z.infer<typeof ChatStreamDeltaEventSchema>

export const ChatStreamFinishEventSchema = z.object({
  event: z.literal('finish'),
  id: z.string(),
  created: z.number(),
  model: z.string(),
  finishReason: z.string(),
})

export type ChatStreamFinishEvent = z.infer<typeof ChatStreamFinishEventSchema>

export const ChatStreamUsageEventSchema = z.object({
  event: z.literal('usage'),
  id: z.string(),
  created: z.number(),
  model: z.string(),
  usage: ChatUsageSchema,
})

export type ChatStreamUsageEvent = z.infer<typeof ChatStreamUsageEventSchema>

export const ChatStreamEventSchema = z.discriminatedUnion('event', [
  ChatStreamDeltaEventSchema,
  ChatStreamFinishEventSchema,
  ChatStreamUsageEventSchema,
])

export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>

// ============================================
// セッション管理付きストリーム
// ============================================

export const ChatSessionStatusSchema = z.enum(['running', 'completed', 'cancelled', 'error'])

export type ChatSessionStatus = z.infer<typeof ChatSessionStatusSchema>

export const ChatSessionStartRequestSchema = ChatApiRequestSchema.extend({
  conversation: ConversationSchema,
  assistantMessageId: z.string().min(1),
})

export type ChatSessionStartRequest = z.infer<typeof ChatSessionStartRequestSchema>

export const ChatSessionStartResponseSchema = z.object({
  sessionId: z.string(),
  status: ChatSessionStatusSchema,
})

export type ChatSessionStartResponse = z.infer<typeof ChatSessionStartResponseSchema>

export const ChatSessionMetaSchema = z.object({
  id: z.string(),
  status: ChatSessionStatusSchema,
  conversation: ConversationSchema,
  assistantMessageId: z.string(),
  apiMode: ApiModeSchema,
  model: z.string(),
  email: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
})

export type ChatSessionMeta = z.infer<typeof ChatSessionMetaSchema>

const ChatSessionEventBaseSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
})

export const ChatSessionEventSchema = z.discriminatedUnion('type', [
  ChatSessionEventBaseSchema.extend({
    type: z.literal('user_message'),
    data: z.object({
      conversation: ConversationSchema,
      assistantMessageId: z.string(),
    }),
  }),
  ChatSessionEventBaseSchema.extend({
    type: z.literal('assistant_delta'),
    data: ChatStreamDeltaEventSchema,
  }),
  ChatSessionEventBaseSchema.extend({
    type: z.literal('assistant_finish'),
    data: ChatStreamFinishEventSchema,
  }),
  ChatSessionEventBaseSchema.extend({
    type: z.literal('usage'),
    data: ChatStreamUsageEventSchema,
  }),
  ChatSessionEventBaseSchema.extend({
    type: z.literal('done'),
    data: z.object({}),
  }),
  ChatSessionEventBaseSchema.extend({
    type: z.literal('cancelled'),
    data: z.object({
      reason: z.string(),
    }),
  }),
  ChatSessionEventBaseSchema.extend({
    type: z.literal('error'),
    data: z.object({
      message: z.string(),
    }),
  }),
])

export type ChatSessionEvent = z.infer<typeof ChatSessionEventSchema>

// ============================================
// 統一エラーレスポンス
// ============================================

export const ChatErrorResponseSchema = z.object({
  error: z.string(),
  code: z.enum(['VALIDATION_ERROR', 'UPSTREAM_ERROR', 'INTERNAL_ERROR']),
})

export type ChatErrorResponse = z.infer<typeof ChatErrorResponseSchema>
