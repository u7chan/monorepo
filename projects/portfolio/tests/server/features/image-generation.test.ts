import { describe, expect, it, vi } from 'vitest'
import {
  generateImage,
  IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_SIZE,
} from '#/server/features/image-generation/image-generation'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
}))

vi.mock('openai', () => ({
  default: vi.fn(function () {
    return {
      images: {
        generate: mocks.generate,
      },
    }
  }),
}))

describe('画像生成機能', () => {
  it('固定のモデル・サイズで生成し Base64 をバイナリに変換する', async () => {
    mocks.generate.mockResolvedValueOnce({
      created: 1_700_000_000,
      data: [{ b64_json: Buffer.from('png-data').toString('base64') }],
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
    })

    const result = await generateImage({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      prompt: 'a small blue house',
    })

    expect(mocks.generate).toHaveBeenCalledWith({
      model: IMAGE_GENERATION_MODEL,
      prompt: 'a small blue house',
      n: 1,
      size: IMAGE_GENERATION_SIZE,
      output_format: 'png',
    })
    expect(Buffer.from(result.content).toString()).toBe('png-data')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34, totalTokens: 46 })
  })
})
