// @vitest-environment jsdom

import { ChatResults } from '#/client/components/chat/chat-results'
import type { AssistantMetadata, Message } from '#/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  cleanup()
})

function createMetadata(overrides?: Partial<AssistantMetadata>): AssistantMetadata {
  return {
    model: 'gpt-test',
    usage: {},
    ...overrides,
  }
}

function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user',
    content: `message-${i}`,
    reasoningContent: '',
    metadata: { model: 'gpt-test' },
  }))
}

function createImageConversationMessages(): Message[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      content: [
        { type: 'text', text: 'これはなに？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,previous' } },
      ],
      metadata: { model: 'gpt-test', sendImagesOnlyOnce: true },
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'レモンです',
      reasoningContent: '',
      metadata: { model: 'gpt-test', usage: {} },
    },
    {
      id: 'user-2',
      role: 'user',
      content: [
        { type: 'text', text: '色は？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } },
      ],
      metadata: { model: 'gpt-test', sendImagesOnlyOnce: true },
    },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: '黄色です',
      reasoningContent: '',
      metadata: {
        model: 'gpt-test',
        usage: {},
        imageContext: { policy: 'send_once', sent: 1, historyOnly: 1 },
      },
    },
  ]
}

describe('ChatResults', () => {
  describe('metadata display', () => {
    it('renders model name and toggles usage badges', () => {
      render(<ChatResults metadata={createMetadata({ finishReason: 'stop', responseTimeMs: 500 })} messages={[]} />)

      const toggleButton = screen.getByText('gpt-test')
      expect(toggleButton).toBeTruthy()

      fireEvent.click(toggleButton)
      expect(screen.getByText('finish_reason:')).toBeTruthy()
      expect(screen.getByText('stop')).toBeTruthy()
    })

    it('returns null when model is empty', () => {
      const { container } = render(<ChatResults metadata={createMetadata({ model: '' })} messages={[]} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('messages dump trigger', () => {
    it('displays current messages count', () => {
      render(<ChatResults metadata={createMetadata()} messages={createMessages(3)} />)

      expect(screen.getByText('messages: (3)')).toBeTruthy()
    })

    it('displays image context summary when present', () => {
      render(
        <ChatResults
          metadata={createMetadata({ imageContext: { policy: 'send_once', sent: 1, historyOnly: 2 } })}
          messages={createMessages(3)}
        />
      )

      expect(screen.getByText('images: 1 sent / 2 history-only')).toBeTruthy()
    })

    it('opens popover on click and shows formatted JSON', () => {
      const messages = createMessages(2)
      render(<ChatResults metadata={createMetadata()} messages={messages} />)

      const dumpButton = screen.getByLabelText('Open messages dump viewer')
      fireEvent.click(dumpButton)

      expect(screen.getByRole('dialog', { name: 'Messages dump viewer' })).toBeTruthy()
      expect(screen.getByText(/"role": "user"/)).toBeTruthy()
    })

    it('can switch dump viewer to API context without omitted history images', () => {
      const messages = createImageConversationMessages()
      render(
        <ChatResults
          metadata={createMetadata({
            imageContext: { policy: 'send_once', sent: 1, historyOnly: 1 },
            apiContextMessages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: '色は？' },
                  { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } },
                ],
              },
            ],
          })}
          messages={messages}
        />
      )

      fireEvent.click(screen.getByLabelText('Open messages dump viewer'))
      expect(screen.getByText('Saved History')).toBeTruthy()
      expect(screen.getByText(/data:image\/png;base64,previous/)).toBeTruthy()

      fireEvent.click(screen.getByText('API Context'))

      expect(screen.getByText(/このビューは実際に送信した API コンテキストです。/)).toBeTruthy()
      expect(screen.queryByText(/data:image\/png;base64,previous/)).toBeNull()
      expect(screen.queryByText(/これはなに？/)).toBeNull()
      expect(screen.getByText(/data:image\/png;base64,current/)).toBeTruthy()
      expect(screen.queryByText(/"metadata":/)).toBeNull()
    })

    it('closes popover on backdrop click', () => {
      const { container } = render(<ChatResults metadata={createMetadata()} messages={createMessages(1)} />)

      fireEvent.click(screen.getByLabelText('Open messages dump viewer'))
      expect(screen.getByRole('dialog')).toBeTruthy()

      const backdrop = container.querySelector('.bg-black\\/50')
      expect(backdrop).toBeTruthy()
      fireEvent.click(backdrop!)
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('closes popover on close button click', () => {
      render(<ChatResults metadata={createMetadata()} messages={createMessages(1)} />)

      fireEvent.click(screen.getByLabelText('Open messages dump viewer'))
      expect(screen.getByRole('dialog')).toBeTruthy()

      fireEvent.click(screen.getByLabelText('Close viewer'))
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('closes popover on Escape key', () => {
      render(<ChatResults metadata={createMetadata()} messages={createMessages(1)} />)

      fireEvent.click(screen.getByLabelText('Open messages dump viewer'))
      expect(screen.getByRole('dialog')).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('copies JSON to clipboard on copy button click', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })

      const messages = createMessages(2)
      render(<ChatResults metadata={createMetadata()} messages={messages} />)

      fireEvent.click(screen.getByLabelText('Open messages dump viewer'))
      fireEvent.click(screen.getByLabelText('Copy JSON'))

      expect(writeText).toHaveBeenCalledWith(JSON.stringify(messages, null, 2))
    })
  })
})
