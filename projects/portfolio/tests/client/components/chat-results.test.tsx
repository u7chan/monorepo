// @vitest-environment jsdom

import { ChatResults } from '#/client/components/chat/chat-results'
import type { AssistantMetadata, Message } from '#/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

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

    it('opens popover on click and shows formatted JSON', () => {
      const messages = createMessages(2)
      render(<ChatResults metadata={createMetadata()} messages={messages} />)

      const dumpButton = screen.getByLabelText('Open messages dump viewer')
      fireEvent.click(dumpButton)

      expect(screen.getByRole('dialog', { name: 'Messages dump viewer' })).toBeTruthy()
      expect(screen.getByText(/"role": "user"/)).toBeTruthy()
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
  })
})
