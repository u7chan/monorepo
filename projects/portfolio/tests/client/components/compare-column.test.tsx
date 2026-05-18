// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CompareColumn } from '#/client/components/chat-compare/compare-column'

describe('CompareColumn', () => {
  it('retrying 状態では再試行中表示を出す', () => {
    render(
      <CompareColumn
        state={{
          model: 'openai/gpt-5.2',
          status: 'retrying',
          messages: [],
          content: '',
          reasoningContent: '',
          usage: null,
          finishReason: null,
          responseTimeMs: null,
          error: null,
          retryAttempt: 1,
        }}
      />
    )

    expect(screen.getByText('リトライ 1/1')).toBeTruthy()
    expect(screen.getByText('60秒間応答がなかったため再試行しています。')).toBeTruthy()
  })

  it('error 状態では最終エラーを表示する', () => {
    render(
      <CompareColumn
        state={{
          model: 'openai/gpt-5.2',
          status: 'error',
          messages: [],
          content: '',
          reasoningContent: '',
          usage: null,
          finishReason: null,
          responseTimeMs: null,
          error: '60秒間応答がなかったため停止しました。1回リトライしました。',
          retryAttempt: 1,
        }}
      />
    )

    expect(screen.getByText('60秒間応答がなかったため停止しました。1回リトライしました。')).toBeTruthy()
  })
})
