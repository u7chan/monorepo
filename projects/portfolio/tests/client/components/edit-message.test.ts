import { describe, expect, it } from 'vitest'
import {
  buildEditedHistory,
  buildEditedSendMessages,
  getUserMessageText,
  prepareApiMessages,
} from '#/client/features/chat/lib/edit-message'
import type { AssistantMessage, Message, SystemMessage, UserMessage } from '#/types'

const createUserMessage = (id: string, content: UserMessage['content']): UserMessage => ({
  id,
  role: 'user',
  content,
  metadata: { model: 'gpt-test' },
})

const createAssistantMessage = (id: string, content: string): AssistantMessage => ({
  id,
  role: 'assistant',
  content,
  metadata: { model: 'gpt-test', usage: {} },
})

const createSystemMessage = (id: string, content: string): SystemMessage => ({
  id,
  role: 'system',
  content,
})

describe('edit-message', () => {
  describe('buildEditedHistory', () => {
    it('対象ユーザーメッセージ以降を切り捨てる', () => {
      const messages: Message[] = [
        createUserMessage('user-1', 'first'),
        createAssistantMessage('assistant-1', 'answer'),
        createUserMessage('user-2', 'second'),
      ]

      expect(buildEditedHistory(messages, 0, 'edited')).toEqual([
        expect.objectContaining({
          id: 'user-1',
          role: 'user',
          content: 'edited',
        }),
      ])
    })

    it('画像付きメッセージは画像を保持してテキストだけ差し替える', () => {
      const messages: Message[] = [
        createUserMessage('user-1', [
          { type: 'text', text: 'before' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ]),
        createAssistantMessage('assistant-1', 'answer'),
      ]

      expect(buildEditedHistory(messages, 0, 'after')).toEqual([
        expect.objectContaining({
          content: [
            { type: 'text', text: 'after' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
          ],
        }),
      ])
    })

    it('空文字やユーザー以外は編集結果を作らない', () => {
      const messages: Message[] = [createAssistantMessage('assistant-1', 'answer')]

      expect(buildEditedHistory(messages, 0, 'edited')).toBeNull()
      expect(buildEditedHistory([createUserMessage('user-1', 'before')], 0, '   ')).toBeNull()
    })
  })

  describe('buildEditedSendMessages', () => {
    it('会話履歴を含める場合は編集済み履歴全体を送る', () => {
      const messages: Message[] = [
        createUserMessage('user-1', 'first'),
        createAssistantMessage('assistant-1', 'answer'),
        createUserMessage('user-2', 'second'),
      ]

      expect(buildEditedSendMessages(messages, 'user-2', true)).toEqual(messages)
    })

    it('会話履歴を含めない場合は編集中ユーザーメッセージだけを送る', () => {
      const messages: Message[] = [
        createUserMessage('user-1', 'first'),
        createAssistantMessage('assistant-1', 'answer'),
        createUserMessage('user-2', 'second'),
      ]

      expect(buildEditedSendMessages(messages, 'user-2', false)).toEqual([messages[2]])
    })

    it('会話履歴を含めない場合でも system prefix だけが前にある場合は保持する', () => {
      const messages: Message[] = [createSystemMessage('system-1', 'prompt'), createUserMessage('user-1', 'first')]

      expect(buildEditedSendMessages(messages, 'user-1', false)).toEqual(messages)
    })
  })

  describe('prepareApiMessages', () => {
    it('過去画像は送信対象から外し、編集中メッセージの画像は保持する', () => {
      const messages: Message[] = [
        createUserMessage('user-1', [
          { type: 'text', text: 'old' },
          { type: 'image_url', image_url: { url: 'old-image' } },
        ]),
        createUserMessage('user-2', [
          { type: 'text', text: 'current' },
          { type: 'image_url', image_url: { url: 'current-image' } },
        ]),
      ]

      expect(prepareApiMessages(messages, 'user-2', true)).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'old' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'current' },
            { type: 'image_url', image_url: { url: 'current-image' } },
          ],
        },
      ])
    })
  })

  describe('getUserMessageText', () => {
    it('配列コンテンツからテキストだけを取り出す', () => {
      expect(
        getUserMessageText(
          createUserMessage('user-1', [
            { type: 'text', text: 'first' },
            { type: 'image_url', image_url: { url: 'image' } },
            { type: 'text', text: 'second' },
          ])
        )
      ).toBe('first\nsecond')
    })
  })
})
