import { describe, expect, it } from 'vitest'
import { buildImageGenerationPrompt } from '#/client/features/chat/lib/image-generation'
import type { Message } from '#/types'

const userMessage = (id: string, content: string, imageGenerationMode = false): Message => ({
  id,
  role: 'user',
  content,
  metadata: {
    model: 'gpt-4o-mini',
    ...(imageGenerationMode ? { imageGenerationMode: true } : {}),
  },
})

describe('画像生成プロンプトの組み立て', () => {
  it('同一会話の画像生成 user prompt だけを履歴に含める', () => {
    const result = buildImageGenerationPrompt(
      [userMessage('normal', '通常チャットの内容'), userMessage('image', '過去の画像 prompt', true)],
      '現在の画像 prompt',
      true
    )

    expect(result).toEqual({
      currentPrompt: '現在の画像 prompt',
      prompt: '過去の画像 prompt\n\n現在の画像 prompt',
    })
  })

  it('履歴設定が Off のとき現在の prompt だけを返す', () => {
    const result = buildImageGenerationPrompt(
      [userMessage('image', '過去の画像 prompt', true)],
      '現在の画像 prompt',
      false
    )

    expect(result).toEqual({
      currentPrompt: '現在の画像 prompt',
      prompt: '現在の画像 prompt',
    })
  })

  it('空の prompt は送信対象にしない', () => {
    expect(buildImageGenerationPrompt([], '  ', true)).toBeNull()
  })
})
