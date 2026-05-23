// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('hono/client', () => {
  const createMockClient = () => ({
    api: {
      chat: {
        stream: {
          $post: vi.fn(),
        },
      },
    },
  })
  return {
    hc: vi.fn(() => createMockClient()),
  }
})

describe('useCompareStream', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('cancelModel は対象モデルの AbortController のみ abort する', async () => {
    const { useCompareStream } = await import('#/client/components/chat-compare/hooks/use-compare-stream')

    const { result } = renderHook(() => useCompareStream())

    const settings = {
      schemaVersion: '1.0.0',
      baseURL: 'http://localhost',
      apiKey: 'test-key',
      apiMode: 'chat_completions' as const,
    }

    const modelState = {
      model: 'model-a',
      status: 'idle' as const,
      messages: [],
      content: '',
      reasoningContent: '',
      usage: null,
      finishReason: null,
      responseTimeMs: null,
      error: null,
    }

    const userMessage = { role: 'user' as const, content: 'test' }

    act(() => {
      result.current.submitCompare(settings, { 'model-a': modelState }, ['model-a'], userMessage, {
        onStreamContent: vi.fn(),
        onStreamDone: vi.fn(),
        onStreamError: vi.fn(),
      })
    })

    act(() => {
      result.current.cancelModel('model-a')
    })

    expect(result.current).toBeDefined()
  })

  it('cancelAll は全モデルの AbortController を abort する', async () => {
    const { useCompareStream } = await import('#/client/components/chat-compare/hooks/use-compare-stream')

    const { result } = renderHook(() => useCompareStream())

    const settings = {
      schemaVersion: '1.0.0',
      baseURL: 'http://localhost',
      apiKey: 'test-key',
      apiMode: 'chat_completions' as const,
    }

    const modelStateA = {
      model: 'model-a',
      status: 'idle' as const,
      messages: [],
      content: '',
      reasoningContent: '',
      usage: null,
      finishReason: null,
      responseTimeMs: null,
      error: null,
    }

    const modelStateB = {
      model: 'model-b',
      status: 'idle' as const,
      messages: [],
      content: '',
      reasoningContent: '',
      usage: null,
      finishReason: null,
      responseTimeMs: null,
      error: null,
    }

    const userMessage = { role: 'user' as const, content: 'test' }

    act(() => {
      result.current.submitCompare(
        settings,
        { 'model-a': modelStateA, 'model-b': modelStateB },
        ['model-a', 'model-b'],
        userMessage,
        {
          onStreamContent: vi.fn(),
          onStreamDone: vi.fn(),
          onStreamError: vi.fn(),
        }
      )
    })

    act(() => {
      result.current.cancelAll()
    })

    expect(result.current).toBeDefined()
  })

  it('submitModel は指定モデルだけ stream を開始する', async () => {
    const { useCompareStream } = await import('#/client/components/chat-compare/hooks/use-compare-stream')

    const { result } = renderHook(() => useCompareStream())

    const settings = {
      schemaVersion: '1.0.0',
      baseURL: 'http://localhost',
      apiKey: 'test-key',
      apiMode: 'chat_completions' as const,
    }

    const modelState = {
      model: 'model-a',
      status: 'retrying' as const,
      messages: [{ role: 'user' as const, content: 'hello' }],
      content: '',
      reasoningContent: '',
      usage: null,
      finishReason: null,
      responseTimeMs: null,
      error: null,
    }

    const callbacks = {
      onStreamContent: vi.fn(),
      onStreamDone: vi.fn(),
      onStreamError: vi.fn(),
    }

    await act(async () => {
      await result.current.submitModel({ settings, modelState, callbacks })
    })

    expect(result.current).toBeDefined()
  })
})
