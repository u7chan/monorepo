import { z } from 'zod'
import { ApiChatMessageSchema } from './chat'

// ============================================
// /api/chat, /api/chat/stream 公開コントラクト
// ============================================

/** /api/chat, /api/chat/stream 共通リクエストスキーマ */
export const ChatApiRequestSchema = z.object({
  messages: ApiChatMessageSchema.array(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().min(1).optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
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
// 統一エラーレスポンス
// ============================================

export const ChatErrorResponseSchema = z.object({
  error: z.string(),
  code: z.enum(['VALIDATION_ERROR', 'UPSTREAM_ERROR', 'INTERNAL_ERROR']),
})

export type ChatErrorResponse = z.infer<typeof ChatErrorResponseSchema>
