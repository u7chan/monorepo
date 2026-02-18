import { z } from 'zod'

export const chatRequestSchema = z.object({
  model: z.string().optional(),
  messages: z
    .object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string().min(1),
    })
    .array()
    .min(1),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().min(1).optional(),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>
