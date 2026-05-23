// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompareColumn } from '#/client/components/chat-compare/compare-column'
import type { ModelStreamState } from '#/client/components/chat-compare/hooks/use-compare-state'

function createModelState(overrides: Partial<ModelStreamState> = {}): ModelStreamState {
  return {
    model: 'test-model',
    status: 'idle',
    messages: [],
    content: '',
    reasoningContent: '',
    usage: null,
    finishReason: null,
    responseTimeMs: null,
    error: null,
    ...overrides,
  }
}

describe('CompareColumn', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  describe('停止ボタン', () => {
    it('は status が streaming の場合に表示される', () => {
      render(
        <CompareColumn
          state={createModelState({ status: 'streaming' })}
          onCancelModel={vi.fn()}
          onRetryModel={vi.fn()}
        />
      )

      expect(screen.queryByLabelText('Stop test-model')).not.toBeNull()
    })

    it('は status が retrying の場合に表示される', () => {
      render(
        <CompareColumn
          state={createModelState({ status: 'retrying' })}
          onCancelModel={vi.fn()}
          onRetryModel={vi.fn()}
        />
      )

      expect(screen.queryByLabelText('Stop test-model')).not.toBeNull()
    })

    it('は status が idle / done / error / cancelled の場合は表示されない', () => {
      const statuses: ModelStreamState['status'][] = ['idle', 'done', 'error', 'cancelled']
      for (const status of statuses) {
        const { unmount } = render(
          <CompareColumn state={createModelState({ status })} onCancelModel={vi.fn()} onRetryModel={vi.fn()} />
        )

        expect(screen.queryByLabelText('Stop test-model')).toBeNull()
        unmount()
      }
    })

    it('は押下時に onCancelModel が model 名とともに呼ばれる', () => {
      const onCancelModel = vi.fn()
      render(
        <CompareColumn
          state={createModelState({ status: 'streaming', model: 'gpt-5' })}
          onCancelModel={onCancelModel}
        />
      )

      fireEvent.click(screen.getByLabelText('Stop gpt-5'))

      expect(onCancelModel).toHaveBeenCalledOnce()
      expect(onCancelModel).toHaveBeenCalledWith('gpt-5')
    })
  })

  describe('再試行ボタン', () => {
    it('は status が error の場合に表示される', () => {
      render(
        <CompareColumn
          state={createModelState({ status: 'error', error: 'timeout' })}
          onCancelModel={vi.fn()}
          onRetryModel={vi.fn()}
        />
      )

      expect(screen.queryByLabelText('Retry test-model')).not.toBeNull()
    })

    it('は status が cancelled の場合に表示される', () => {
      render(
        <CompareColumn
          state={createModelState({ status: 'cancelled', error: 'Cancelled by user' })}
          onCancelModel={vi.fn()}
          onRetryModel={vi.fn()}
        />
      )

      expect(screen.queryByLabelText('Retry test-model')).not.toBeNull()
    })

    it('は status が idle / streaming / retrying / done の場合は表示されない', () => {
      const statuses: ModelStreamState['status'][] = ['idle', 'streaming', 'retrying', 'done']
      for (const status of statuses) {
        const { unmount } = render(
          <CompareColumn state={createModelState({ status })} onCancelModel={vi.fn()} onRetryModel={vi.fn()} />
        )

        expect(screen.queryByLabelText('Retry test-model')).toBeNull()
        unmount()
      }
    })

    it('は押下時に onRetryModel が model 名とともに呼ばれる', () => {
      const onRetryModel = vi.fn()
      render(
        <CompareColumn
          state={createModelState({ status: 'error', error: 'timeout', model: 'claude-sonnet' })}
          onRetryModel={onRetryModel}
        />
      )

      fireEvent.click(screen.getByLabelText('Retry claude-sonnet'))

      expect(onRetryModel).toHaveBeenCalledOnce()
      expect(onRetryModel).toHaveBeenCalledWith('claude-sonnet')
    })
  })

  describe('エラー表示', () => {
    it('は error 文字列がある場合にエラーメッセージを表示する', () => {
      render(
        <CompareColumn
          state={createModelState({ status: 'error', error: 'Response timed out' })}
          onCancelModel={vi.fn()}
          onRetryModel={vi.fn()}
        />
      )

      expect(screen.getByText('Response timed out')).toBeTruthy()
    })

    it('は cancelled ステータスでも error 文字列を表示する', () => {
      render(
        <CompareColumn
          state={createModelState({ status: 'cancelled', error: 'Cancelled by user' })}
          onCancelModel={vi.fn()}
          onRetryModel={vi.fn()}
        />
      )

      expect(screen.getByText('Cancelled by user')).toBeTruthy()
    })
  })
})
