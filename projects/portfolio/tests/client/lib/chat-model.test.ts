import { describe, expect, it } from 'vitest'
import { resolveChatModel } from '#/client/features/chat/lib/chat-model'

describe('resolveChatModel', () => {
  describe('保存値が一覧にある', () => {
    it('保存値をそのまま使う', () => {
      expect(
        resolveChatModel({
          savedModel: 'gpt-4.1-mini',
          availableModels: ['gpt-4.1-mini', 'gpt-4.1'],
        })
      ).toBe('gpt-4.1-mini')
    })
  })

  describe('保存値が一覧にない', () => {
    it('一覧の先頭のモデルに置き換える', () => {
      expect(
        resolveChatModel({
          savedModel: 'gpt-4.1-mini',
          availableModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        })
      ).toBe('gemini-2.5-flash')
    })

    it('一覧が1件だけでもそのモデルを選ぶ', () => {
      expect(
        resolveChatModel({
          savedModel: 'gpt-4.1-mini',
          availableModels: ['gemini-2.5-flash'],
        })
      ).toBe('gemini-2.5-flash')
    })

    it('保存値が空でも一覧の先頭を選ぶ', () => {
      expect(resolveChatModel({ savedModel: '', availableModels: ['gemini-2.5-flash'] })).toBe('gemini-2.5-flash')
    })
  })

  describe('一覧が空', () => {
    it('保存値があっても未解決として null を返す', () => {
      expect(resolveChatModel({ savedModel: 'gpt-4.1-mini', availableModels: [] })).toBeNull()
    })
  })
})
