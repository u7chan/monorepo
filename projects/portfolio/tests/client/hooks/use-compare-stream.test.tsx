// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('useCompareStream', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const importSubject = async () => {
    const chatStreamPostMock = vi.fn()

    vi.doMock('hono/client', () => ({
      hc: () => ({
        api: {
          chat: {
            stream: {
              $post: chatStreamPostMock,
            },
          },
        },
      }),
    }))

    const mod = await import('#/client/components/chat-compare/hooks/use-compare-stream')

    return {
      useCompareStream: mod.useCompareStream,
      chatStreamPostMock,
      STREAM_IDLE_TIMEOUT_MS: mod.STREAM_IDLE_TIMEOUT_MS,
    }
  }

  const settings = {
    schemaVersion: '1.0.0',
    apiKey: 'api-key',
    baseURL: 'https://example.com',
    apiMode: 'chat_completions' as const,
  }

  const modelStates = {
    'openai/gpt-5.2': {
      model: 'openai/gpt-5.2',
      status: 'idle' as const,
      messages: [{ role: 'user' as const, content: 'previous question' }],
      content: '',
      reasoningContent: '',
      usage: null,
      finishReason: null,
      responseTimeMs: null,
      error: null,
      retryAttempt: 0,
    },
    'openai/gpt-5.4-mini': {
      model: 'openai/gpt-5.4-mini',
      status: 'idle' as const,
      messages: [{ role: 'user' as const, content: 'previous question' }],
      content: '',
      reasoningContent: '',
      usage: null,
      finishReason: null,
      responseTimeMs: null,
      error: null,
      retryAttempt: 0,
    },
  }

  const userMessage = { role: 'user' as const, content: 'hello' }

  const createCallbacks = () => ({
    onStreamContent: vi.fn(),
    onStreamDone: vi.fn(),
    onStreamError: vi.fn(),
    onStreamRetry: vi.fn(),
  })

  const createReaderFromChunks = (chunks: Uint8Array[]) => ({
    getReader() {
      let index = 0

      return {
        read: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined }
          }

          return { done: false, value: chunks[index++] }
        },
      }
    },
  })

  const createHangingBody = (signal: AbortSignal) => ({
    getReader() {
      return {
        read: async () =>
          new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Aborted', 'AbortError'))
            if (signal.aborted) {
              abort()
              return
            }
            signal.addEventListener('abort', abort, { once: true })
          }),
      }
    },
  })

  it('タイムアウトしたモデルだけ 1 回自動リトライして完了する', async () => {
    const { useCompareStream, chatStreamPostMock, STREAM_IDLE_TIMEOUT_MS } = await importSubject()
    const encoder = new TextEncoder()
    const callbacks = createCallbacks()

    chatStreamPostMock
      .mockImplementationOnce((_req: unknown, options: { init: { signal: AbortSignal } }) =>
        Promise.resolve({
          ok: true,
          body: createHangingBody(options.init.signal),
        })
      )
      .mockResolvedValueOnce({
        ok: true,
        body: createReaderFromChunks([
          encoder.encode('data: {"event":"delta","id":"chunk-1","created":1,"model":"openai/gpt-5.2","content":"retry"}\n'),
          encoder.encode('data: {"event":"finish","id":"chunk-1","created":1,"model":"openai/gpt-5.2","finishReason":"stop"}\n'),
          encoder.encode('data: [DONE]\n'),
        ]),
      })

    const { result } = renderHook(() => useCompareStream())

    let promise: Promise<void> | undefined
    act(() => {
      promise = result.current.submitCompare(
        settings,
        { 'openai/gpt-5.2': modelStates['openai/gpt-5.2'] },
        ['openai/gpt-5.2'],
        userMessage,
        callbacks
      )
    })

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS)
    await promise

    expect(chatStreamPostMock).toHaveBeenCalledTimes(2)
    expect(callbacks.onStreamRetry).toHaveBeenCalledWith('openai/gpt-5.2', 1)
    expect(callbacks.onStreamDone).toHaveBeenCalledWith(
      'openai/gpt-5.2',
      expect.objectContaining({
        finishReason: 'stop',
        content: 'retry',
      })
    )
    expect(callbacks.onStreamError).not.toHaveBeenCalled()
    expect(chatStreamPostMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        json: {
          apiMode: 'chat_completions',
          model: 'openai/gpt-5.2',
          messages: [
            { role: 'user', content: 'previous question' },
            { role: 'user', content: 'hello' },
          ],
        },
      }),
      expect.anything()
    )
  })

  it('2 回目もタイムアウトした場合はエラーで終了する', async () => {
    const { useCompareStream, chatStreamPostMock, STREAM_IDLE_TIMEOUT_MS } = await importSubject()
    const callbacks = createCallbacks()

    chatStreamPostMock.mockImplementation((_req: unknown, options: { init: { signal: AbortSignal } }) =>
      Promise.resolve({
        ok: true,
        body: createHangingBody(options.init.signal),
      })
    )

    const { result } = renderHook(() => useCompareStream())

    let promise: Promise<void> | undefined
    act(() => {
      promise = result.current.submitCompare(
        settings,
        { 'openai/gpt-5.2': modelStates['openai/gpt-5.2'] },
        ['openai/gpt-5.2'],
        userMessage,
        callbacks
      )
    })

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)
    await promise

    expect(chatStreamPostMock).toHaveBeenCalledTimes(2)
    expect(callbacks.onStreamRetry).toHaveBeenCalledTimes(1)
    expect(callbacks.onStreamError).toHaveBeenCalledWith(
      'openai/gpt-5.2',
      '60秒間応答がなかったため停止しました。1回リトライしました。'
    )
    expect(callbacks.onStreamDone).not.toHaveBeenCalled()
  })

  it('1 モデルだけタイムアウトしても他モデルの完了は維持される', async () => {
    const { useCompareStream, chatStreamPostMock, STREAM_IDLE_TIMEOUT_MS } = await importSubject()
    const encoder = new TextEncoder()
    const callbacks = createCallbacks()

    chatStreamPostMock.mockImplementation((req: { json: { model: string } }, options: { init: { signal: AbortSignal } }) => {
      if (req.json.model === 'openai/gpt-5.4-mini') {
        return Promise.resolve({
          ok: true,
          body: createReaderFromChunks([
            encoder.encode(
              'data: {"event":"delta","id":"chunk-fast","created":1,"model":"openai/gpt-5.4-mini","content":"fast"}\n'
            ),
            encoder.encode(
              'data: {"event":"finish","id":"chunk-fast","created":1,"model":"openai/gpt-5.4-mini","finishReason":"stop"}\n'
            ),
            encoder.encode('data: [DONE]\n'),
          ]),
        })
      }

      return Promise.resolve({
        ok: true,
        body: createHangingBody(options.init.signal),
      })
    })

    const { result } = renderHook(() => useCompareStream())

    let promise: Promise<void> | undefined
    act(() => {
      promise = result.current.submitCompare(
        settings,
        modelStates,
        ['openai/gpt-5.2', 'openai/gpt-5.4-mini'],
        userMessage,
        callbacks
      )
    })

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)
    await promise

    expect(callbacks.onStreamDone).toHaveBeenCalledWith(
      'openai/gpt-5.4-mini',
      expect.objectContaining({
        finishReason: 'stop',
        content: 'fast',
      })
    )
    expect(callbacks.onStreamError).toHaveBeenCalledWith(
      'openai/gpt-5.2',
      '60秒間応答がなかったため停止しました。1回リトライしました。'
    )
  })

  it('cancelAll で全モデルを停止し、エラーにしない', async () => {
    const { useCompareStream, chatStreamPostMock } = await importSubject()
    const callbacks = createCallbacks()
    const seenSignals: AbortSignal[] = []

    chatStreamPostMock.mockImplementation((_req: unknown, options: { init: { signal: AbortSignal } }) => {
      seenSignals.push(options.init.signal)
      return Promise.resolve({
        ok: true,
        body: createHangingBody(options.init.signal),
      })
    })

    const { result } = renderHook(() => useCompareStream())

    let promise: Promise<void> | undefined
    act(() => {
      promise = result.current.submitCompare(
        settings,
        modelStates,
        ['openai/gpt-5.2', 'openai/gpt-5.4-mini'],
        userMessage,
        callbacks
      )
    })

    act(() => {
      result.current.cancelAll()
    })

    await promise

    expect(seenSignals).toHaveLength(2)
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true)
    expect(callbacks.onStreamError).not.toHaveBeenCalled()
    expect(callbacks.onStreamDone).not.toHaveBeenCalled()
  })
})
