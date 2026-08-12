import { describe, expect, it } from 'vitest'
import { validateChatSettings } from '#/client/features/chat/lib/chat-settings-validation'

describe('chat-settings-validation', () => {
  describe('通常の API 接続', () => {
    it('baseURL と apiKey が空なら送信を拒否する', () => {
      expect(validateChatSettings({ baseURL: '', apiKey: '', fakeMode: false })).toMatchObject({
        code: 'VALIDATION_ERROR',
      })
    })

    it('有効な URL と apiKey なら送信を許可する', () => {
      expect(validateChatSettings({ baseURL: 'https://example.com/v1', apiKey: 'api-key', fakeMode: false })).toBeNull()
    })

    it('URL 形式が不正なら送信を拒否する', () => {
      expect(validateChatSettings({ baseURL: 'not-a-url', apiKey: 'api-key', fakeMode: false })).toMatchObject({
        code: 'VALIDATION_ERROR',
      })
    })
  })

  describe('Fake Mode', () => {
    it('通常対話では Fake Mode の接続情報検証を省略する', () => {
      expect(validateChatSettings({ baseURL: '', apiKey: '', fakeMode: true }, { allowFakeMode: true })).toBeNull()
    })

    it('画像生成では Fake Mode でも接続情報検証を行う', () => {
      expect(validateChatSettings({ baseURL: '', apiKey: '', fakeMode: true })).toMatchObject({
        code: 'VALIDATION_ERROR',
      })
    })
  })
})
