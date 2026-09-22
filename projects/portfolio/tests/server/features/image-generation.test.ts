import { describe, expect, it, vi } from 'vitest'
import { generateImage, IMAGE_GENERATION_SIZE } from '#/server/features/image-generation/image-generation'

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
  it('指定されたモデルと固定のサイズで生成し Base64 をバイナリに変換する', async () => {
    mocks.generate.mockResolvedValueOnce({
      created: 1_700_000_000,
      model: null,
      data: [{ b64_json: Buffer.from('png-data').toString('base64') }],
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
    })

    const result = await generateImage({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      model: 'openai/gpt-image-2.5-flare',
      prompt: 'a small blue house',
    })

    expect(mocks.generate).toHaveBeenCalledWith({
      model: 'openai/gpt-image-2.5-flare',
      prompt: 'a small blue house',
      n: 1,
      size: IMAGE_GENERATION_SIZE,
      output_format: 'png',
    })
    expect(result.model).toBe('openai/gpt-image-2.5-flare')
    expect(Buffer.from(result.content).toString()).toBe('png-data')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34, totalTokens: 46 })
  })
})
