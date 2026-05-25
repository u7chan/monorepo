// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageRenderer } from '#/client/components/chat/message-renderer'
import type { AssistantMessage, UserMessage } from '#/types'

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
  describe('ユーザーメッセージ編集', () => {
    const userMessage: UserMessage = {
      id: 'user-1',
      role: 'user',
      content: '修正前',
      metadata: { model: 'gpt-test' },
    }

    it('保存クリック直後に編集表示を閉じる', async () => {
      const onEditMessage = vi.fn(() => new Promise<void>(() => undefined))

      render(
        <MessageRenderer
          message={userMessage}
          index={0}
          messages={[userMessage]}
          conversationId='conversation-1'
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onEditMessage={onEditMessage}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
      fireEvent.change(screen.getByLabelText('Edit message text'), { target: { value: '修正後' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save edited message' }))

      await waitFor(() => {
        expect(screen.queryByLabelText('Edit message text')).toBeNull()
      })
      expect(onEditMessage).toHaveBeenCalledWith(0, '修正後')
    })

    it('チャット送信開始などで無効化されたら編集表示を閉じる', async () => {
      const { rerender } = render(
        <MessageRenderer
          message={userMessage}
          index={0}
          messages={[userMessage]}
          conversationId='conversation-1'
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
          onEditMessage={vi.fn()}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
      expect(screen.getByLabelText('Edit message text')).toBeTruthy()

      rerender(
        <MessageRenderer
          message={userMessage}
          index={0}
          messages={[userMessage]}
          conversationId='conversation-1'
          markdownPreview={true}
          copied={false}
          disabled={true}
          onCopyMessage={vi.fn()}
          onEditMessage={vi.fn()}
        />
      )

      await waitFor(() => {
        expect(screen.queryByLabelText('Edit message text')).toBeNull()
      })
    })
  })

  describe('画像コンテキスト表示', () => {
    const renderUserMessage = (message: UserMessage, sendImagesOnlyOnce: boolean) =>
      render(
        <MessageRenderer
          message={message}
          index={0}
          messages={[message]}
          conversationId='conversation-1'
          markdownPreview={true}
          sendImagesOnlyOnce={sendImagesOnlyOnce}
          copied={false}
          onCopyMessage={vi.fn()}
        />
      )

    it('ON の画像付き user message は履歴のみとして表示する', () => {
      renderUserMessage(
        {
          id: 'user-1',
          role: 'user',
          content: [
            { type: 'text', text: '画像です' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } },
          ],
          metadata: { model: 'gpt-test', sendImagesOnlyOnce: true },
        },
        true
      )

      expect(screen.getByText('履歴のみ')).toBeTruthy()
    })

    it('OFF の画像付き user message はコンテキスト対象として表示する', () => {
      renderUserMessage(
        {
          id: 'user-1',
          role: 'user',
          content: [
            { type: 'text', text: '画像です' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } },
          ],
          metadata: { model: 'gpt-test', sendImagesOnlyOnce: false },
        },
        false
      )

      expect(screen.getByText('コンテキスト対象')).toBeTruthy()
    })

    it('送信時 metadata がある場合は現在設定より優先して表示する', () => {
      renderUserMessage(
        {
          id: 'user-1',
          role: 'user',
          content: [
            { type: 'text', text: '画像です' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } },
          ],
          metadata: { model: 'gpt-test', sendImagesOnlyOnce: true },
        },
        false
      )

      expect(screen.getByText('履歴のみ')).toBeTruthy()
    })
  })

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

  describe('Markdown セキュリティ', () => {
    it('危険な HTML を DOM として描画しない', () => {
      const { container } = render(
        <MessageRenderer
          message={createAssistantMessage('<script>alert("xss")</script><img src=x onerror=alert(1)>')}
          index={0}
          messages={[]}
          conversationId='conversation-1'
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
        />
      )

      expect(container.querySelector('script')).toBeNull()
      expect(container.querySelector('img')).toBeNull()
    })

    it('Markdown link に rel を付与する', () => {
      render(
        <MessageRenderer
          message={createAssistantMessage('[example](https://example.com)')}
          index={0}
          messages={[]}
          conversationId='conversation-1'
          markdownPreview={true}
          copied={false}
          onCopyMessage={vi.fn()}
        />
      )

      expect(screen.getByRole('link', { name: 'example' }).getAttribute('rel')).toBe('noopener noreferrer')
    })
  })
})
