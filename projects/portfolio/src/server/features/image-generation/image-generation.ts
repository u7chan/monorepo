import OpenAI from 'openai'
import type { ImageGenerationUsage } from '#/types/image-generation-api'

export const IMAGE_GENERATION_MODEL = 'gpt-image-2'
export const IMAGE_GENERATION_SIZE = '1024x1024'
export const IMAGE_GENERATION_CONTENT_TYPE = 'image/png' as const

export interface GeneratedImagePayload {
  id: string
  created: number
  model: string
  content: ArrayBuffer
  usage: ImageGenerationUsage
}

export async function generateImage({
  apiKey,
  baseURL,
  prompt,
}: {
  apiKey: string
  baseURL: string
  prompt: string
}): Promise<GeneratedImagePayload> {
  const openai = new OpenAI({ apiKey, baseURL })
  const response = await openai.images.generate({
    model: IMAGE_GENERATION_MODEL,
    prompt,
    n: 1,
    size: IMAGE_GENERATION_SIZE,
    output_format: 'png',
  })

  const image = response.data?.[0]
  if (!image?.b64_json) {
    throw new Error('Image provider returned no image data')
  }

  const bytes = Buffer.from(image.b64_json, 'base64')
  const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

  return {
    id: `image_${response.created}`,
    created: response.created,
    model: IMAGE_GENERATION_MODEL,
    content,
    usage: {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      totalTokens: response.usage?.total_tokens,
    },
  }
}
