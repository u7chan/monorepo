import { z } from 'zod'

// ============================================
// ベース型（Zod スキーマ）
// ============================================

export const ApiModeSchema = z.enum(['chat_completions', 'responses'])

export type ApiMode = z.infer<typeof ApiModeSchema>

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

export const UserMetadataSchema = z
  .object({
    model: z.string().catch(''),
    apiMode: ApiModeSchema.optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
  })
  .catch({ model: '' })

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

export const GeneratedCodeFileSchema = z.object({
  blockIndex: z.number().int().nonnegative(),
  language: z.string(),
  fileName: z.string(),
  publicPath: z.string(),
  previewUrl: z.string(),
  contentType: z.string(),
  createdAt: z.string(),
})

export type GeneratedCodeFile = z.infer<typeof GeneratedCodeFileSchema>

export const AssistantMetadataSchema = z
  .object({
    model: z.string().catch(''),
    apiMode: ApiModeSchema.optional(),
    finishReason: z.string().optional(),
    responseTimeMs: z.number().optional(),
    usage: z
      .object({
        completionTokens: z.number().optional(),
        promptTokens: z.number().optional(),
        totalTokens: z.number().optional(),
        reasoningTokens: z.number().optional(),
      })
      .catch({}),
    generatedFiles: z.array(GeneratedCodeFileSchema).optional(),
  })
  .catch({ model: '', usage: {} })

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
  updatedAt: z.coerce.date().optional(),
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
