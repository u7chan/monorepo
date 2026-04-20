// @vitest-environment jsdom

import { MessageRenderer } from '#/client/components/chat/message-renderer'
import type { AssistantMessage } from '#/types'
import { cleanup, render, screen } from '@testing-library/react'
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

function createAssistantMessage(
  content: string,
  generatedFiles?: AssistantMessage['metadata']['generatedFiles']
): AssistantMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content,
    reasoningContent: '',
    metadata: {
      model: 'gpt-test',
      usage: {},
      generatedFiles,
    },
  }
}

describe('MessageRenderer', () => {
  describe('生成コードアクション', () => {
    it('未認証なら対応言語でも生成ボタンを表示しない', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```html\n<div>Hello</div>\n```')}
          index={0}
          conversationId='conversation-1'
          canSaveGeneratedFile={false}
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onSaveGeneratedFile={vi.fn().mockResolvedValue(null)}
        />
      )

      expect(screen.queryByRole('button', { name: '生成' })).toBeNull()
    })

    it('認証済みなら対応言語の生成ボタンを表示する', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```html\n<div>Hello</div>\n```')}
          index={0}
          conversationId='conversation-1'
          canSaveGeneratedFile={true}
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onSaveGeneratedFile={vi.fn().mockResolvedValue(null)}
        />
      )

      expect(screen.getByRole('button', { name: '生成' })).toBeTruthy()
    })

    it('非対応言語なら認証済みでも生成ボタンを表示しない', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```typescript\nconst value = 1\n```')}
          index={0}
          conversationId='conversation-1'
          canSaveGeneratedFile={true}
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onSaveGeneratedFile={vi.fn().mockResolvedValue(null)}
        />
      )

      expect(screen.queryByRole('button', { name: '生成' })).toBeNull()
    })
  })

  describe('既存生成ファイル', () => {
    it('未認証でも既存プレビューは表示する', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```html\n<div>Hello</div>\n```', [
            {
              blockIndex: 0,
              language: 'html',
              fileName: 'message-1-block-0.html',
              publicPath: '/public/portfolio/c1/message-1-block-0.html',
              previewUrl: 'http://files.example.com/public/portfolio/c1/message-1-block-0.html',
              contentType: 'text/html; charset=utf-8',
              createdAt: '2026-04-19T00:00:00.000Z',
            },
          ])}
          index={0}
          conversationId='conversation-1'
          canSaveGeneratedFile={false}
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onSaveGeneratedFile={vi.fn().mockResolvedValue(null)}
        />
      )

      const previewLink = screen.getByRole('link', { name: 'Preview code block' })
      expect(previewLink).toBeTruthy()
      expect(previewLink.getAttribute('href')).toBe(
        'http://files.example.com/public/portfolio/c1/message-1-block-0.html'
      )
      expect(screen.queryByRole('button', { name: '生成' })).toBeNull()
    })
  })
})
