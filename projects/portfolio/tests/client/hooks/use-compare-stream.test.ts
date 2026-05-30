// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock$post = vi.fn()

vi.mock('hono/client', () => ({
  hc: vi.fn(() => ({
    api: { chat: { stream: { $post: mock$post } } },
  })),
}))

describe('useCompareStream', () => {
  let abortSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    mock$post.mockReset()
    mock$post.mockReturnValue(new Promise<{ ok: false; json: () => Promise<Record<string, unknown>> }>(() => {}))
    abortSpy = vi.spyOn(AbortController.prototype, 'abort')
  })

  afterEach(() => {
    abortSpy.mockRestore()
  })

  const settings = {
    schemaVersion: '1.0.0',
    baseURL: 'http://localhost',
    apiKey: 'test-key',
    apiMode: 'chat_completions' as const,
  }

  it('cancelModel は対象モデルの AbortController のみ abort する', async () => {
    const { useCompareStream } = await import('#/client/features/chat-compare/hooks/use-compare-stream')

    const { result } = renderHook(() => useCompareStream())

    act(() => {
      result.current.submitCompare(
        settings,
        {
          'model-a': {
            model: 'model-a',
            status: 'idle' as const,
            messages: [],
            content: '',
            reasoningContent: '',
            usage: null,
            finishReason: null,
            responseTimeMs: null,
            error: null,
          },
        },
        ['model-a'],
        { role: 'user' as const, content: 'test' },
        { onStreamContent: vi.fn(), onStreamDone: vi.fn(), onStreamError: vi.fn() }
      )
    })

    act(() => {
      result.current.cancelModel('model-a')
    })

    expect(abortSpy).toHaveBeenCalled()
  })

  it('cancelAll は全モデルの AbortController を abort する', async () => {
    const { useCompareStream } = await import('#/client/features/chat-compare/hooks/use-compare-stream')

    const { result } = renderHook(() => useCompareStream())

    act(() => {
      result.current.submitCompare(
        settings,
        {
          'model-a': {
            model: 'model-a',
            status: 'idle' as const,
            messages: [],
            content: '',
            reasoningContent: '',
            usage: null,
            finishReason: null,
            responseTimeMs: null,
            error: null,
          },
          'model-b': {
            model: 'model-b',
            status: 'idle' as const,
            messages: [],
            content: '',
            reasoningContent: '',
            usage: null,
            finishReason: null,
            responseTimeMs: null,
            error: null,
          },
        },
        ['model-a', 'model-b'],
        { role: 'user' as const, content: 'test' },
        { onStreamContent: vi.fn(), onStreamDone: vi.fn(), onStreamError: vi.fn() }
      )
    })

    act(() => {
      result.current.cancelAll()
    })

    expect(abortSpy).toHaveBeenCalledTimes(2)
  })

  it('submitModel は正しい引数で stream API を呼び出す', async () => {
    mock$post.mockReset()
    mock$post.mockReturnValue(new Promise(() => {}))

    const { useCompareStream } = await import('#/client/features/chat-compare/hooks/use-compare-stream')

    const { result } = renderHook(() => useCompareStream())

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

    act(() => {
      result.current.submitModel({ settings, modelState, callbacks })
    })

    expect(mock$post).toHaveBeenCalledOnce()
    const callArgs = mock$post.mock.calls[0]

    const requestArg = callArgs[0] as { json: { model: string; messages: typeof modelState.messages } }
    expect(requestArg.json.model).toBe('model-a')
    expect(requestArg.json.messages).toEqual([{ role: 'user', content: 'hello' }])

    const headers = requestArg as unknown as { header: Record<string, string> }
    expect(headers.header['api-key']).toBe('test-key')
    expect(headers.header['base-url']).toBe('http://localhost')
  })

  it('submitModel は既存の controller がある場合に abort してから新しい controller をセットする', async () => {
    mock$post.mockReset()
    mock$post.mockReturnValue(new Promise(() => {}))

    const { useCompareStream } = await import('#/client/features/chat-compare/hooks/use-compare-stream')

    const { result } = renderHook(() => useCompareStream())

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

    act(() => {
      result.current.submitModel({ settings, modelState, callbacks })
    })

    const callsAfterFirst = abortSpy.mock.calls.length

    act(() => {
      result.current.submitModel({ settings, modelState, callbacks })
    })

    expect(abortSpy).toHaveBeenCalledTimes(callsAfterFirst + 1)
  })
})
