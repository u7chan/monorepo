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
// メッセージ型（Zod スキーマ）
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

// ============================================
// API 通信用の内部型
// ============================================

/** API リクエスト用のメッセージ型 */
export interface ChatMessageUser {
  role: 'user'
  content: string | Array<TextContent | ImageContent>
}

export interface ChatMessageAssistant {
  role: 'assistant'
  content: string
  reasoning_content?: string // API 形式に合わせてスネークケース
}

export interface ChatMessageSystem {
  role: 'system'
  content: string
}

export type ChatMessage = ChatMessageUser | ChatMessageAssistant | ChatMessageSystem

// ============================================
// API レスポンス型
// ============================================

export interface ChatCompletionResult {
  model: string
  finishReason: string
  message: {
    content: string
    reasoningContent: string
  }
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
