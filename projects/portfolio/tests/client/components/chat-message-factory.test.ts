import {
  createAssistantMessage,
  createConversationTitle,
  resolveChatRequestSettings,
} from '#/client/components/chat/chat-message-factory'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { ChatResponse } from '#/types/chat-api'
import { describe, expect, it } from 'vitest'

const settings: Settings = {
  schemaVersion: '1.4.0',
  model: 'gpt-4.1-mini',
  baseURL: 'https://example.test',
  apiKey: 'secret',
  apiMode: 'chat_completions',
  temperature: 0.7,
  temperatureEnabled: true,
  maxTokens: 256,
  reasoningEffort: 'high',
  reasoningEffortEnabled: true,
  fakeMode: false,
  autoModel: false,
  markdownPreview: true,
  streamMode: true,
  includeChatHistory: true,
  sendImagesOnlyOnce: true,
  sidebarOpen: true,
  templateModels: {},
}

const response: ChatResponse = {
  id: 'response-1',
  created: 1700000000,
  model: 'gpt-test',
  finishReason: 'stop',
  message: {
    content: '回答',
    reasoningContent: 'reasoning',
  },
  usage: null,
}

describe('chat-message-factory', () => {
  describe('createAssistantMessage', () => {
    it('usage がない場合は token 数を 0 にして metadata を作る', () => {
      expect(
        createAssistantMessage({
          assistantMessageId: 'assistant-1',
          result: response,
          apiMode: 'chat_completions',
          responseTimeMs: 123,
        })
      ).toEqual({
        id: 'assistant-1',
        role: 'assistant',
        content: '回答',
        reasoningContent: 'reasoning',
        metadata: {
          model: 'gpt-test',
          apiMode: 'chat_completions',
          finishReason: 'stop',
          responseTimeMs: 123,
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            reasoningTokens: undefined,
          },
          imageContext: undefined,
          apiContextMessages: undefined,
        },
      })
    })

    it('画像コンテキストと API コンテキストを metadata に残す', () => {
      const message = createAssistantMessage({
        assistantMessageId: 'assistant-1',
        result: {
          ...response,
          usage: {
            promptTokens: 1,
            completionTokens: 2,
            totalTokens: 3,
            reasoningTokens: 4,
          },
        },
        apiMode: 'responses',
        responseTimeMs: 456,
        imageContext: { policy: 'send_once', sent: 1, historyOnly: 2 },
        apiContextMessages: [{ role: 'user', content: '質問' }],
      })

      expect(message.metadata).toMatchObject({
        apiMode: 'responses',
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
          reasoningTokens: 4,
        },
        imageContext: { policy: 'send_once', sent: 1, historyOnly: 2 },
        apiContextMessages: [{ role: 'user', content: '質問' }],
      })
    })
  })

  describe('createConversationTitle', () => {
    it('文字列は 10 文字で切り詰め、画像付き content は空にする', () => {
      expect(createConversationTitle('12345678901')).toBe('1234567890')
      expect(createConversationTitle([{ type: 'text', text: '画像付き' }])).toBe('')
    })
  })

  describe('resolveChatRequestSettings', () => {
    it('有効な送信設定だけを解決する', () => {
      expect(resolveChatRequestSettings(settings)).toEqual({
        model: 'gpt-4.1-mini',
        baseURL: 'https://example.test',
        apiKey: 'secret',
        temperature: 0.7,
        maxTokens: 256,
        reasoningEffort: 'high',
      })
    })

    it('fake mode では接続情報と model を fakemode にする', () => {
      expect(resolveChatRequestSettings({ ...settings, fakeMode: true })).toMatchObject({
        model: 'fakemode',
        baseURL: 'fakemode',
        apiKey: 'fakemode',
      })
    })
  })
})
