import { readChatError, unknownChatError } from '#/client/shared/lib/chat-error'
import { ImageGenerationResponseSchema } from '#/types/image-generation-api'
import type { ImageGenerationResponse } from '#/types/image-generation-api'

export interface SendImageGenerationParams {
  abortController: AbortController
  header: {
    apiKey: string
    baseURL: string
  }
  prompt: string
  conversationId: string
  assistantMessageId: string
}

export async function sendImageGeneration(
  req: SendImageGenerationParams
): Promise<{ result: ImageGenerationResponse | null; error: ReturnType<typeof unknownChatError> | null }> {
  try {
    const response = await fetch('/api/image/generations', {
      method: 'POST',
      headers: {
        'api-key': req.header.apiKey,
        'base-url': req.header.baseURL,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        conversationId: req.conversationId,
        assistantMessageId: req.assistantMessageId,
      }),
      signal: req.abortController.signal,
    })

    if (!response.ok) {
      return { result: null, error: await readChatError(response) }
    }

    const parsed = ImageGenerationResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      return { result: null, error: unknownChatError() }
    }

    return { result: parsed.data, error: null }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { result: null, error: null }
    }
    return { result: null, error: unknownChatError() }
  }
}
