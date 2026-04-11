import { z } from 'zod'

// ============================================
// ベース型（Zod スキーマ）
// ============================================

/** 画像コンテンツ */
export const ImageContentSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
  }),
})

export type ImageContent = z.infer<typeof ImageContentSchema>

/** テキストコンテンツ */
export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export type TextContent = z.infer<typeof TextContentSchema>

// ============================================
// 共有ドメイン型 — UI state・会話保存の正本
// ============================================

export const UserMetadataSchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
})

export type UserMetadata = z.infer<typeof UserMetadataSchema>

export const UserMessageSchema = z.object({
  id: z.string().optional(),
  role: z.literal('user'),
  // 修正: string | Array<TextContent | ImageContent> に対応
  content: z.union([z.string(), z.array(z.union([TextContentSchema, ImageContentSchema]))]),
  reasoningContent: z.string().default(''),
  metadata: UserMetadataSchema,
})

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AssistantMetadataSchema = z.object({
  model: z.string(),
  finishReason: z.string().optional(),
  responseTimeMs: z.number().optional(),
  usage: z.object({
    completionTokens: z.number().optional(),
    promptTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  }),
})

export type AssistantMetadata = z.infer<typeof AssistantMetadataSchema>

export const AssistantMessageSchema = z.object({
  id: z.string().optional(),
  role: z.literal('assistant'),
  content: z.string(),
  reasoningContent: z.string().optional(), // 修正: optional に変更
  metadata: AssistantMetadataSchema,
})

export type AssistantMessage = z.infer<typeof AssistantMessageSchema>

export const SystemMessageSchema = z.object({
  id: z.string().optional(),
  role: z.literal('system'),
  content: z.string(),
  reasoningContent: z.string().default(''),
  metadata: z.object({}).optional(),
})

export type SystemMessage = z.infer<typeof SystemMessageSchema>

// 判別Union型
export const MessageSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
  SystemMessageSchema,
])

export type Message = z.infer<typeof MessageSchema>

// ============================================
// 会話型（Zod スキーマ）
// ============================================

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(MessageSchema),
})

export type Conversation = z.infer<typeof ConversationSchema>

export const ConversationListResponseSchema = z.object({
  data: z.array(ConversationSchema),
})

export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>

// ============================================
// /api/chat HTTP wire 型 — 送信時の変換先
// ============================================

/** /api/chat に送るメッセージの wire スキーマ（metadata・reasoningContent は含まない） */
export const ApiChatMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.union([z.string().min(1), z.array(z.union([TextContentSchema, ImageContentSchema]))]),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().min(1),
  }),
  z.object({
    role: z.literal('system'),
    content: z.string().min(1),
  }),
])

export type ApiChatMessage = z.infer<typeof ApiChatMessageSchema>

/** /api/chat リクエスト本体の共有スキーマ */
export const ApiChatRequestSchema = z.object({
  messages: ApiChatMessageSchema.array(),
  model: z.string().min(1),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(1).optional(),
  max_tokens: z.number().min(1).optional(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
})

export type ApiChatRequest = z.infer<typeof ApiChatRequestSchema>

/** ドメイン Message → /api/chat wire メッセージへの変換 */
export function toApiChatMessage(message: Message): ApiChatMessage {
  if (message.role === 'user') {
    return { role: 'user', content: message.content }
  }
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.content }
  }
  return { role: 'system', content: message.content }
}

// ============================================
// API レスポンス型
// ============================================

const ApiUsageSchema = z
  .object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
    reasoning_tokens: z.number().optional(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().optional(),
      })
      .optional(),
  })
  .nullable()

export const ChatCompletionResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
        reasoning_content: z.string().optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    })
  ),
  model: z.string().optional(),
  usage: ApiUsageSchema.optional(),
})

export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>

export const ChatCompletionStreamChunkSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().optional(),
        reasoning_content: z.string().optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    })
  ),
  model: z.string().optional(),
  usage: ApiUsageSchema.optional(),
})

export type ChatCompletionStreamChunk = z.infer<typeof ChatCompletionStreamChunkSchema>

export interface ChatStreamState {
  content: string
  reasoning_content?: string
}

export interface ChatResultSummary {
  model?: string
  finish_reason: string
  responseTimeMs?: number
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    reasoningTokens?: number
  } | null
}

export interface ChatCompletionResult {
  model: string
  finishReason: string
  message: {
    content: string
    reasoningContent: string
  }
  responseTimeMs: number
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    reasoningTokens?: number
  } | null
}

// ============================================
// 型ガード関数
// ============================================

export function isUserMessage(message: Message): message is UserMessage {
  return message.role === 'user'
}

export function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

export function isSystemMessage(message: Message): message is SystemMessage {
  return message.role === 'system'
}

export function isImageContentArray(
  content: string | Array<TextContent | ImageContent>
): content is Array<TextContent | ImageContent> {
  return Array.isArray(content)
}
