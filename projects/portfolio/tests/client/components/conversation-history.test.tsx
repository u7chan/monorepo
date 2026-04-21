// @vitest-environment jsdom

import { ConversationHistory } from '#/client/components/chat/conversation-history'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('ConversationHistory', () => {
  it('updatedAt がある会話は日付とメッセージ数アイコンを表示する', () => {
    const { container } = render(
      <ConversationHistory
        conversations={[
          {
            id: 'conversation-1',
            title: '会話1',
            updatedAt: new Date('2026-04-14T12:34:56.000Z'),
            messages: [
              {
                id: 'message-1',
                role: 'user',
                content: 'hello',
                reasoningContent: '',
                metadata: { model: 'gpt-test' },
              },
              {
                id: 'message-2',
                role: 'assistant',
                content: 'world',
                reasoningContent: '',
                metadata: { model: 'gpt-test', usage: {} },
              },
            ],
          },
        ]}
        currentConversationId={null}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        onNewConversation={vi.fn()}
      />
    )

    expect(screen.getByText('2026/04/14')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(within(container).getByLabelText('message-icon')).toBeTruthy()
  })

  it('updatedAt がない会話はメッセージ数アイコンのみ表示する', () => {
    const { container } = render(
      <ConversationHistory
        conversations={[
          {
            id: 'conversation-1',
            title: '会話1',
            messages: [
              {
                id: 'message-1',
                role: 'user',
                content: 'hello',
                reasoningContent: '',
                metadata: { model: 'gpt-test' },
              },
            ],
          },
        ]}
        currentConversationId={null}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        onNewConversation={vi.fn()}
      />
    )

    expect(screen.getByText('1')).toBeTruthy()
    expect(within(container).getByLabelText('message-icon')).toBeTruthy()
  })
})
