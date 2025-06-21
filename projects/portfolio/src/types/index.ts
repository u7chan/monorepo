import { z } from 'zod'

const UserMetadata = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
})

const AssistantMetadata = z.object({
  model: z.string(),
  finishReason: z.string().optional(),
  usage: z.object({
    completionTokens: z.number().optional(),
    promptTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  }),
})

const MessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.string(),
    reasoningContent: z.string(),
    metadata: UserMetadata,
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    reasoningContent: z.string(),
    metadata: AssistantMetadata,
  }),
  z.object({
    role: z.literal('system'),
    content: z.string(),
    reasoningContent: z.string(),
    metadata: z.object({}).optional(),
  }),
])

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(MessageSchema),
})

export type Conversation = z.infer<typeof ConversationSchema>
