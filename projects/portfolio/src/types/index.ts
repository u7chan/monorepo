import { z } from 'zod'

const UserMetadataSchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
})

const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.string(),
  reasoningContent: z.string(),
  metadata: UserMetadataSchema,
})

const AssistantMetadataSchema = z.object({
  model: z.string(),
  finishReason: z.string().optional(),
  usage: z.object({
    completionTokens: z.number().optional(),
    promptTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  }),
})

const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string(),
  reasoningContent: z.string(),
  metadata: AssistantMetadataSchema,
})

const SystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  reasoningContent: z.string(),
  metadata: z.object({}).optional(),
})

const MessageSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
  SystemMessageSchema
])

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(MessageSchema),
})

export type Conversation = z.infer<typeof ConversationSchema>
