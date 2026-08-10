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
// アプリケーションエラー
// ============================================

export const ChatErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'AUTHENTICATION_FAILED',
  'MODEL_ACCESS_DENIED',
  'INSUFFICIENT_CREDIT',
  'RATE_LIMITED',
  'INVALID_REQUEST',
  'UPSTREAM_UNAVAILABLE',
  'UNKNOWN_UPSTREAM_ERROR',
  'IMAGE_STORAGE_NOT_CONFIGURED',
  'IMAGE_STORAGE_FAILED',
  'IMAGE_MODEL_ENDPOINT_INCOMPATIBLE',
  'IMAGE_REQUEST_INVALID',
  'IMAGE_PROVIDER_REJECTED',
])

export type ChatErrorCode = z.infer<typeof ChatErrorCodeSchema>

/** UI に安全に表示できるよう正規化したエラー。provider の生レスポンスは含めない。 */
export const ChatErrorSchema = z.object({
  code: ChatErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
})

export type ChatError = z.infer<typeof ChatErrorSchema>

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
  error: ChatErrorSchema.nullable(),
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
    type: z.literal('generation_error'),
    data: ChatErrorSchema,
  }),
])

export type ChatSessionEvent = z.infer<typeof ChatSessionEventSchema>

// ============================================
// HTTP エラーレスポンス
// ============================================

export const ChatErrorResponseSchema = ChatErrorSchema

export type ChatErrorResponse = ChatError
