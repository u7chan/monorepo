import { z } from 'zod'

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  reasoningContent: z.string(),
  metadata: z.object({
    // request
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    // response
    finishReason: z.string().optional(),
    completionTokens: z.number().optional(),
    promptTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  }),
})

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(MessageSchema),
})

export type Conversation = z.infer<typeof ConversationSchema>
