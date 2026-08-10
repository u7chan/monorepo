import { z } from 'zod'
import { GeneratedImageSchema } from './chat'

export const ImageGenerationRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(32000),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  assistantMessageId: z.string().regex(/^[A-Za-z0-9_-]+$/),
})

export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>

export const ImageGenerationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
})

export type ImageGenerationUsage = z.infer<typeof ImageGenerationUsageSchema>

export const ImageGenerationResponseSchema = z.object({
  id: z.string(),
  created: z.number(),
  model: z.string(),
  image: GeneratedImageSchema,
  usage: ImageGenerationUsageSchema,
})

export type ImageGenerationResponse = z.infer<typeof ImageGenerationResponseSchema>
