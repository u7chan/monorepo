// @vitest-environment jsdom

import { ChatMessageList } from '#/client/components/chat/chat-message-list'
import type { AssistantMessage } from '#/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children: string }) => <pre>{children}</pre>,
}))

vi.mock('react-syntax-highlighter/dist/cjs/styles/prism', () => ({
  atomDark: {},
}))

afterEach(() => {
  cleanup()
})

function createAssistantMessage(id: string, content: string): AssistantMessage {
  return {
    id,
    role: 'assistant',
    content,
    reasoningContent: '',
    metadata: {
      model: 'gpt-test',
      usage: {},
    },
  }
}

describe('ChatMessageList', () => {
  describe('ストリーム中のコードブロック', () => {
    it('完了後も開閉状態を維持する', () => {
      const messageEndRef = createRef<HTMLDivElement>()
      const props = {
        messages: [],
        conversationId: 'conversation-1',
        markdownPreview: true,
        loading: true,
        stream: {
          content: '```typescript\nconst value = 1\n```',
          reasoningContent: '',
        },
        streamMessageId: 'assistant-1',
        copiedId: '',
        messageEndRef,
        onCopyMessage: vi.fn(),
        onDeleteMessage: vi.fn(),
      }

      const { rerender } = render(<ChatMessageList {...props} />)
      fireEvent.click(screen.getByRole('button', { name: 'Expand code block' }))

      rerender(
        <ChatMessageList
          {...props}
          messages={[createAssistantMessage('assistant-1', '```typescript\nconst value = 1\n```')]}
          loading={false}
          stream={null}
        />
      )

      expect(screen.getByRole('button', { name: 'Collapse code block' })).toBeTruthy()
    })
  })
})
