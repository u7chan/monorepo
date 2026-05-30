// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('useStreamProcessor', () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  const importSubject = async () => {
    const chatPostMock = vi.fn()
    const chatStreamPostMock = vi.fn()
    const chatSessionPostMock = vi.fn()
    const chatSessionCancelPostMock = vi.fn()

    vi.doMock('hono/client', () => ({
      hc: () => ({
        api: {
          chat: {
            $post: chatPostMock,
            stream: {
              $post: chatStreamPostMock,
            },
            sessions: {
              $post: chatSessionPostMock,
              ':sessionId': {
                cancel: {
                  $post: chatSessionCancelPostMock,
                },
              },
            },
          },
        },
      }),
    }))

    const mod = await import('#/client/features/chat/hooks/use-stream-processor')

    return {
      useStreamProcessor: mod.useStreamProcessor,
      chatPostMock,
      chatStreamPostMock,
      chatSessionPostMock,
      chatSessionCancelPostMock,
    }
  }

  const request = {
    header: {
      apiKey: 'api-key',
      baseURL: 'https://example.com',
    },
    apiMode: 'chat_completions' as const,
    model: 'gpt-test',
    messages: [],
    temperature: undefined,
    maxTokens: undefined,
    reasoningEffort: undefined,
  }

  const stubEventSource = () => {
    const eventSources: FakeEventSource[] = []

    class FakeEventSource {
      listeners = new Map<string, Array<(message: MessageEvent) => void>>()
      onerror: (() => void) | null = null
      url: string

      constructor(url: string) {
        this.url = url
        eventSources.push(this)
      }

      addEventListener(type: string, listener: (message: MessageEvent) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
      }

      emit(type: string, data: unknown) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(new MessageEvent(type, { data: JSON.stringify(data) }))
        }
      }

      close() {}
    }

    vi.stubGlobal('EventSource', FakeEventSource)

    return eventSources
  }

  it('非 stream の reasoning-only 応答を保持する', async () => {
    const { useStreamProcessor, chatPostMock } = await importSubject()
    chatPostMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-1',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: '',
          reasoningContent: 'thinking only',
        },
        usage: null,
      }),
    })

    const { result } = renderHook(() => useStreamProcessor())

    let response: Awaited<ReturnType<typeof result.current.submitChatCompletion>> | undefined
    await act(async () => {
      response = await result.current.submitChatCompletion({
        ...request,
        streamMode: false,
      })
    })

    expect(response).toEqual({
      result: {
        id: 'chatcmpl-1',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: '',
          reasoningContent: 'thinking only',
        },
        usage: null,
      },
      responseTimeMs: expect.any(Number),
    })
  })

  it('非 stream のリクエストに送信設定を含める', async () => {
    const { useStreamProcessor, chatPostMock } = await importSubject()
    chatPostMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-1',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: 'answer',
          reasoningContent: '',
        },
        usage: null,
      }),
    })

    const { result } = renderHook(() => useStreamProcessor())

    await act(async () => {
      await result.current.submitChatCompletion({
        ...request,
        streamMode: false,
        temperature: 0.4,
        maxTokens: 256,
      })
    })

    expect(chatPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          temperature: 0.4,
          maxTokens: 256,
        }),
      }),
      expect.anything()
    )
  })

  it('stream の reasoning-only 応答を保持する', async () => {
    const { useStreamProcessor, chatStreamPostMock } = await importSubject()
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode(
        'data: {"event":"delta","id":"chunk-1","created":1700000000,"model":"gpt-test","reasoningContent":"thinking"}\n'
      ),
      encoder.encode(
        'data: {"event":"finish","id":"chunk-1","created":1700000000,"model":"gpt-test","finishReason":"stop"}\n'
      ),
      encoder.encode('data: [DONE]\n'),
    ]

    chatStreamPostMock.mockResolvedValue({
      ok: true,
      body: {
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
      },
    })

    const { result } = renderHook(() => useStreamProcessor())

    let response: Awaited<ReturnType<typeof result.current.submitChatCompletion>> | undefined
    await act(async () => {
      response = await result.current.submitChatCompletion({
        ...request,
        streamMode: true,
      })
    })

    expect(response).toEqual({
      result: {
        id: 'chunk-1',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: '',
          reasoningContent: 'thinking',
        },
        usage: null,
      },
      responseTimeMs: expect.any(Number),
    })
  })

  it('finish 未受信の stream は null を返す', async () => {
    const { useStreamProcessor, chatStreamPostMock } = await importSubject()
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode(
        'data: {"event":"delta","id":"chunk-1","created":1700000000,"model":"gpt-test","content":"partial"}\n'
      ),
      encoder.encode('data: [DONE]\n'),
    ]

    chatStreamPostMock.mockResolvedValue({
      ok: true,
      body: {
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
      },
    })

    const { result } = renderHook(() => useStreamProcessor())

    let response: Awaited<ReturnType<typeof result.current.submitChatCompletion>> | undefined
    await act(async () => {
      response = await result.current.submitChatCompletion({
        ...request,
        streamMode: true,
      })
    })

    expect(response).toEqual({
      result: null,
      responseTimeMs: expect.any(Number),
    })
  })

  it('session replay の user_message で会話を復元する', async () => {
    const { useStreamProcessor, chatSessionPostMock } = await importSubject()
    const onSessionConversation = vi.fn()
    const conversation = {
      id: 'conversation-1',
      title: 'hello',
      messages: [
        {
          id: 'message-user-1',
          role: 'user' as const,
          content: 'hello',
          metadata: {
            model: 'gpt-test',
          },
        },
      ],
    }
    const eventSources = stubEventSource()
    chatSessionPostMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'session-1' }),
    })

    const { result } = renderHook(() => useStreamProcessor({ onSessionConversation }))

    const submitChatCompletion = result.current.submitChatCompletion
    let responsePromise: ReturnType<typeof submitChatCompletion> | undefined
    act(() => {
      responsePromise = submitChatCompletion({
        ...request,
        streamMode: true,
        conversation,
        assistantMessageId: 'message-assistant-1',
      })
    })

    await waitFor(() => expect(eventSources).toHaveLength(1))

    act(() => {
      eventSources[0].emit('user_message', {
        id: 'event-1',
        sessionId: 'session-1',
        type: 'user_message',
        createdAt: '2026-05-10T00:00:00.000Z',
        data: {
          conversation,
          assistantMessageId: 'message-assistant-1',
        },
      })
      eventSources[0].emit('assistant_delta', {
        id: 'event-2',
        sessionId: 'session-1',
        type: 'assistant_delta',
        createdAt: '2026-05-10T00:00:01.000Z',
        data: {
          event: 'delta',
          id: 'chunk-1',
          created: 1700000000,
          model: 'gpt-test',
          content: 'answer',
        },
      })
      eventSources[0].emit('assistant_finish', {
        id: 'event-3',
        sessionId: 'session-1',
        type: 'assistant_finish',
        createdAt: '2026-05-10T00:00:02.000Z',
        data: {
          event: 'finish',
          id: 'chunk-1',
          created: 1700000000,
          model: 'gpt-test',
          finishReason: 'stop',
        },
      })
      eventSources[0].emit('done', {
        id: 'event-4',
        sessionId: 'session-1',
        type: 'done',
        createdAt: '2026-05-10T00:00:03.000Z',
        data: {},
      })
    })

    await expect(responsePromise).resolves.toMatchObject({
      result: {
        message: {
          content: 'answer',
        },
      },
    })
    expect(onSessionConversation).toHaveBeenCalledWith(conversation, 'message-assistant-1')
    expect(sessionStorage.getItem('portfolio.chat.activeSession')).toContain('session-1')
    expect(chatSessionPostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        header: {
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        json: expect.objectContaining({
          conversation,
          assistantMessageId: 'message-assistant-1',
        }),
      }),
      expect.anything()
    )
  })

  it('session event stream の一時的な onerror 後も terminal event まで待つ', async () => {
    const { useStreamProcessor, chatSessionPostMock } = await importSubject()
    const conversation = {
      id: 'conversation-1',
      title: 'hello',
      messages: [
        {
          id: 'message-user-1',
          role: 'user' as const,
          content: 'hello',
          metadata: {
            model: 'gpt-test',
          },
        },
      ],
    }
    const eventSources = stubEventSource()
    chatSessionPostMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'session-1' }),
    })

    const { result } = renderHook(() => useStreamProcessor())

    const submitChatCompletion = result.current.submitChatCompletion
    let responseSettled = false
    let responsePromise: ReturnType<typeof submitChatCompletion> | undefined
    act(() => {
      responsePromise = submitChatCompletion({
        ...request,
        streamMode: true,
        conversation,
        assistantMessageId: 'message-assistant-1',
      })
      responsePromise.finally(() => {
        responseSettled = true
      })
    })

    await waitFor(() => expect(eventSources).toHaveLength(1))

    act(() => {
      eventSources[0].onerror?.()
    })
    expect(responseSettled).toBe(false)

    act(() => {
      eventSources[0].emit('user_message', {
        id: 'event-1',
        sessionId: 'session-1',
        type: 'user_message',
        createdAt: '2026-05-10T00:00:00.000Z',
        data: {
          conversation,
          assistantMessageId: 'message-assistant-1',
        },
      })
      eventSources[0].emit('assistant_delta', {
        id: 'event-2',
        sessionId: 'session-1',
        type: 'assistant_delta',
        createdAt: '2026-05-10T00:00:01.000Z',
        data: {
          event: 'delta',
          id: 'chunk-1',
          created: 1700000000,
          model: 'gpt-test',
          content: 'answer after reconnect',
        },
      })
      eventSources[0].emit('assistant_finish', {
        id: 'event-3',
        sessionId: 'session-1',
        type: 'assistant_finish',
        createdAt: '2026-05-10T00:00:02.000Z',
        data: {
          event: 'finish',
          id: 'chunk-1',
          created: 1700000000,
          model: 'gpt-test',
          finishReason: 'stop',
        },
      })
      eventSources[0].emit('done', {
        id: 'event-4',
        sessionId: 'session-1',
        type: 'done',
        createdAt: '2026-05-10T00:00:03.000Z',
        data: {},
      })
    })

    await expect(responsePromise).resolves.toMatchObject({
      result: {
        message: {
          content: 'answer after reconnect',
        },
      },
    })
  })

  it('session stream の cancel は RPC で通知し、ローカルでも null 完了する', async () => {
    const { useStreamProcessor, chatSessionPostMock, chatSessionCancelPostMock } = await importSubject()
    const conversation = {
      id: 'conversation-1',
      title: 'hello',
      messages: [
        {
          id: 'message-user-1',
          role: 'user' as const,
          content: 'hello',
          metadata: {
            model: 'gpt-test',
          },
        },
      ],
    }
    const eventSources = stubEventSource()
    chatSessionPostMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'session-1' }),
    })
    chatSessionCancelPostMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'cancelled' }),
    })

    const { result } = renderHook(() => useStreamProcessor())
    const submitChatCompletion = result.current.submitChatCompletion
    const cancelStream = result.current.cancelStream
    let responsePromise: ReturnType<typeof submitChatCompletion> | undefined

    act(() => {
      responsePromise = submitChatCompletion({
        ...request,
        streamMode: true,
        conversation,
        assistantMessageId: 'message-assistant-1',
      })
    })

    await waitFor(() => expect(eventSources).toHaveLength(1))

    act(() => {
      cancelStream()
    })

    await expect(responsePromise).resolves.toMatchObject({ result: null })
    expect(chatSessionCancelPostMock).toHaveBeenCalledWith({
      param: { sessionId: 'session-1' },
    })
  })
})
