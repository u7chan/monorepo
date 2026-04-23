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
  describe('コードブロックの開閉', () => {
    it('4行以上なら初期表示では閉じている', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```typescript\nconst a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n```')}
          index={0}
          messages={[]}
          conversationId='conversation-1'
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
        />
      )

      expect(screen.getByRole('button', { name: 'Expand code block' })).toBeTruthy()
      expect(screen.getByText('折りたたみ中（4 行・クリックで展開）')).toBeTruthy()
      expect(screen.getByText((text) => text.includes('const a = 1'))).toBeTruthy()
    })

    it('3行以下なら折りたたみ操作を表示せず全文表示する', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```typescript\nconst a = 1\nconst b = 2\nconst c = 3\n```')}
          index={0}
          messages={[]}
          conversationId='conversation-1'
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
        />
      )

      expect(screen.queryByRole('button', { name: 'Expand code block' })).toBeNull()
      expect(screen.queryByText('折りたたみ中（3 行・クリックで展開）')).toBeNull()
      expect(screen.getByText((text) => text.includes('const c = 3'))).toBeTruthy()
    })
  })

  describe('生成コードアクション', () => {
    it('未認証なら対応言語でも生成ボタンを表示しない', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```html\n<div>Hello</div>\n```')}
          index={0}
          messages={[]}
          conversationId='conversation-1'
          canSaveGeneratedFile={false}
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onSaveGeneratedFile={vi.fn().mockResolvedValue(null)}
        />
      )

      expect(screen.queryByRole('button', { name: 'Generate preview' })).toBeNull()
    })

    it('認証済みなら対応言語の生成ボタンを表示する', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```html\n<div>Hello</div>\n```')}
          index={0}
          messages={[]}
          conversationId='conversation-1'
          canSaveGeneratedFile={true}
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onSaveGeneratedFile={vi.fn().mockResolvedValue(null)}
        />
      )

      expect(screen.getByRole('button', { name: 'Generate preview' })).toBeTruthy()
    })

    it('非対応言語なら認証済みでも生成ボタンを表示しない', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('```typescript\nconst value = 1\n```')}
          index={0}
          messages={[]}
          conversationId='conversation-1'
          canSaveGeneratedFile={true}
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onSaveGeneratedFile={vi.fn().mockResolvedValue(null)}
        />
      )

      expect(screen.queryByRole('button', { name: 'Generate preview' })).toBeNull()
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
          messages={[]}
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
      expect(screen.queryByRole('button', { name: 'Generate preview' })).toBeNull()
    })
  })
})
