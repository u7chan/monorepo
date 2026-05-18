// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCompareState } from '#/client/components/chat-compare/hooks/use-compare-state'

describe('useCompareState', () => {
  it('setModelRetrying は retry 状態へ切り替え、途中表示と error をクリアする', () => {
    const { result } = renderHook(() => useCompareState())

    act(() => {
      result.current.initModelStates(['openai/gpt-5.2'])
      result.current.setModelStreaming('openai/gpt-5.2')
      result.current.updateStreamingContent('openai/gpt-5.2', 'partial', 'thinking')
      result.current.setModelError('openai/gpt-5.2', 'previous error')
      result.current.setModelRetrying('openai/gpt-5.2', 1)
    })

    expect(result.current.modelStates['openai/gpt-5.2']).toEqual(
      expect.objectContaining({
        status: 'retrying',
        content: '',
        reasoningContent: '',
        error: null,
        retryAttempt: 1,
      })
    )
  })

  it('setModelError は途中表示を保持して error 状態へ切り替える', () => {
    const { result } = renderHook(() => useCompareState())

    act(() => {
      result.current.initModelStates(['openai/gpt-5.2'])
      result.current.setModelStreaming('openai/gpt-5.2')
      result.current.updateStreamingContent('openai/gpt-5.2', 'partial', 'thinking')
      result.current.setModelError('openai/gpt-5.2', 'stream failed')
    })

    expect(result.current.modelStates['openai/gpt-5.2']).toEqual(
      expect.objectContaining({
        status: 'error',
        content: 'partial',
        reasoningContent: 'thinking',
        error: 'stream failed',
      })
    )
  })
})
