import { describe, expect, it } from 'vitest'
import {
  isImageGenerationConnectionConfigured,
  resolveImageGenerationConnection,
  resolveImageGenerationModel,
} from '#/client/features/chat/lib/image-generation-model'

describe('resolveImageGenerationModel', () => {
  describe('保存値', () => {
    it('一覧にある保存値をそのまま使う', () => {
      expect(
        resolveImageGenerationModel({
          savedModel: 'openai/gpt-image-2.5-sunburst',
          availableModels: ['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst'],
        })
      ).toBe('openai/gpt-image-2.5-sunburst')
    })

    it('一覧にない保存値は優先順の候補で置き換える', () => {
      expect(
        resolveImageGenerationModel({
          savedModel: 'openai/gpt-image-1',
          availableModels: ['openai/gpt-image-2', 'openai/gpt-image-2.5-flare'],
        })
      ).toBe('openai/gpt-image-2.5-flare')
    })
  })

  describe('優先順フォールバック', () => {
    it('flare → sunburst → gpt-image-2 の順に末尾一致で選ぶ', () => {
      expect(
        resolveImageGenerationModel({
          savedModel: '',
          availableModels: ['openai/gpt-image-2', 'openai/gpt-image-2.5-sunburst'],
        })
      ).toBe('openai/gpt-image-2.5-sunburst')

      expect(
        resolveImageGenerationModel({
          savedModel: '',
          availableModels: ['openai/gpt-image-2', 'openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare'],
        })
      ).toBe('openai/gpt-image-2.5-flare')
    })

    it('優先順のモデルがなければ一覧の先頭を使う', () => {
      expect(
        resolveImageGenerationModel({
          savedModel: '',
          availableModels: ['custom-image-model', 'another-image-model'],
        })
      ).toBe('custom-image-model')
    })
  })

  describe('一覧が空', () => {
    it('保存値があっても未選択として null を返す', () => {
      expect(resolveImageGenerationModel({ savedModel: 'openai/gpt-image-2', availableModels: [] })).toBeNull()
    })
  })
})

describe('resolveImageGenerationConnection', () => {
  it('画像生成用の設定が空の場合はチャット用の設定を使う', () => {
    expect(
      resolveImageGenerationConnection({
        baseURL: 'https://chat.example.com/v1',
        apiKey: 'chat-key',
        imageGenerationBaseURL: '',
        imageGenerationApiKey: '',
      })
    ).toEqual({ baseURL: 'https://chat.example.com/v1', apiKey: 'chat-key' })
  })

  it('画像生成用の設定があればそちらを優先する', () => {
    expect(
      resolveImageGenerationConnection({
        baseURL: 'https://chat.example.com/v1',
        apiKey: 'chat-key',
        imageGenerationBaseURL: 'https://image.example.com/v1',
        imageGenerationApiKey: 'image-key',
      })
    ).toEqual({ baseURL: 'https://image.example.com/v1', apiKey: 'image-key' })
  })

  it('Base URL と API Key の両方が揃っているときだけ設定済みとみなす', () => {
    expect(isImageGenerationConnectionConfigured({ baseURL: 'https://image.example.com/v1', apiKey: '' })).toBe(false)
    expect(
      isImageGenerationConnectionConfigured({ baseURL: 'https://image.example.com/v1', apiKey: 'image-key' })
    ).toBe(true)
  })
})
