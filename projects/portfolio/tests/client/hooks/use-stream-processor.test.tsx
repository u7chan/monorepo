// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useStreamProcessor', () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  const importSubject = async () => {
    const chatPostMock = vi.fn()
    const chatStreamPostMock = vi.fn()

    vi.doMock('hono/client', () => ({
      hc: () => ({
        api: {
          chat: {
            $post: chatPostMock,
            stream: {
              $post: chatStreamPostMock,
            },
          },
        },
      }),
    }))

    const mod = await import('#/client/components/chat/hooks/use-stream-processor')

    return {
      useStreamProcessor: mod.useStreamProcessor,
      chatPostMock,
      chatStreamPostMock,
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
    const { useStreamProcessor } = await importSubject()
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessionId: 'session-1' }),
      })
    )

    const { result } = renderHook(() => useStreamProcessor({ onSessionConversation }))

    let response: Awaited<ReturnType<typeof result.current.submitChatCompletion>> | undefined
    void act(async () => {
      response = await result.current.submitChatCompletion({
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

    await waitFor(() => expect(response?.result?.message.content).toBe('answer'))
    expect(onSessionConversation).toHaveBeenCalledWith(conversation, 'message-assistant-1')
  })
})
