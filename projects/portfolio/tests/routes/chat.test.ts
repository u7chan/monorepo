import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../helpers/mock-logger'

const readFileSyncMock = vi.fn((filePath: string) =>
  filePath.includes('reasoning') ? 'reasoning content' : 'response content'
)

const importSubject = async () => {
  const loggerMock = mockLogger()
  const completionsMock = vi.fn()
  const chatStubCompletionsMock = vi.fn()
  const chatStubStreamCompletionsMock = vi.fn()
  const getSignedCookieMock = vi.fn().mockResolvedValue('test@example.com')
  const upsertConversationMock = vi.fn()

  vi.doMock('#/server/features/chat/chat', async () => {
    const actual = await vi.importActual<typeof import('#/server/features/chat/chat')>('#/server/features/chat/chat')

    return {
      ...actual,
      chat: {
        completions: completionsMock,
      },
    }
  })
  vi.doMock('#/server/features/chat-stub/chat-stub', () => ({
    chatStub: {
      completions: chatStubCompletionsMock,
      streamCompletions: chatStubStreamCompletionsMock,
    },
  }))
  vi.doMock('node:fs', () => ({
    default: {
      readFileSync: readFileSyncMock,
    },
  }))
  vi.doMock('hono/cookie', async () => {
    const actual = await vi.importActual<typeof import('hono/cookie')>('hono/cookie')

    return {
      ...actual,
      getSignedCookie: getSignedCookieMock,
      deleteCookie: vi.fn(),
    }
  })
  vi.doMock('#/server/features/chat-conversations/repository', () => ({
    chatConversationRepository: {
      upsert: upsertConversationMock,
    },
  }))

  const { chatRoutes } = await import('#/server/routes/chat')

  return {
    chatRoutes,
    completionsMock,
    chatStubCompletionsMock,
    chatStubStreamCompletionsMock,
    getSignedCookieMock,
    upsertConversationMock,
    loggerMock,
  }
}

describe('chatRoutes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  describe('POST /api/chat', () => {
    it('必須 header がない場合は 400 を返す', async () => {
      const { chatRoutes } = await importSubject()

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('code', 'VALIDATION_ERROR')
    })

    it('fakemode では base-url をローカル endpoint に置き換える', async () => {
      vi.stubEnv('SERVER_PORT', '3456')
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockResolvedValue({
        id: 'completion-1',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      })

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'fakemode',
          'base-url': 'not-a-url',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(200)
      expect(completionsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://localhost:3456/api',
        }),
        expect.objectContaining({
          model: 'gpt-test',
          stream: false,
        })
      )
    })

    it('正規化された ChatResponse を返す', async () => {
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockResolvedValue({
        id: 'chatcmpl-abc',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer', reasoning_content: 'thinking', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      })

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({
        id: 'chatcmpl-abc',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: 'answer',
          reasoningContent: 'thinking',
        },
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          reasoningTokens: 5,
        },
      })
    })

    it('apiMode 未指定時は chat_completions を既定値で渡す', async () => {
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockResolvedValue({
        id: 'chatcmpl-abc',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      })

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(200)
      expect(completionsMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          apiMode: 'chat_completions',
        })
      )
    })

    it('debug ログに request と provider 向けパラメータを残す', async () => {
      const { chatRoutes, completionsMock, loggerMock } = await importSubject()
      completionsMock.mockResolvedValue({
        id: 'chatcmpl-abc',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      })

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hello' }],
          temperature: 0.4,
          maxTokens: 256,
          reasoningEffort: 'high',
        }),
      })

      expect(res.status).toBe(200)
      expect(loggerMock.debug).toHaveBeenCalledWith(
        {
          request: expect.objectContaining({
            baseURL: 'https://example.com',
            apiMode: 'chat_completions',
            appRequest: expect.objectContaining({
              temperature: 0.4,
              maxTokens: 256,
              stream: false,
            }),
            providerRequest: expect.objectContaining({
              temperature: 0.4,
              max_tokens: 256,
              reasoning_effort: 'high',
              stream: false,
            }),
          }),
        },
        'Chat request received'
      )
    })

    it('responses モードの非 stream 応答を既存 ChatResponse に正規化する', async () => {
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockResolvedValue({
        id: 'resp_1',
        created_at: 1700000000,
        model: 'gpt-test',
        output_text: 'answer',
        output: [
          {
            id: 'rs_1',
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'thinking' }],
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 30,
        },
      })

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          apiMode: 'responses',
          messages: [],
        }),
      })

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({
        id: 'resp_1',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: 'answer',
          reasoningContent: 'thinking',
        },
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          reasoningTokens: 5,
        },
      })
    })

    it('不正な body は公開契約の validation error 形式で 400 を返す', async () => {
      const { chatRoutes } = await importSubject()

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: '',
          messages: [],
        }),
      })

      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: "Invalid request body 'model'",
        code: 'VALIDATION_ERROR',
      })
    })

    it('upstream エラー時は 502 を返す', async () => {
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockRejectedValue(new Error('Connection refused'))

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toEqual({
        error: 'Connection refused',
        code: 'UPSTREAM_ERROR',
      })
    })

    it('production の upstream エラー時は詳細を隠す', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockRejectedValue(new Error('Connection refused'))

      const res = await chatRoutes.request('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(502)
      await expect(res.json()).resolves.toEqual({
        error: 'Upstream error',
        code: 'UPSTREAM_ERROR',
      })
    })
  })

  describe('POST /api/chat/stream', () => {
    const createStreamChunk = async function* () {
      yield {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              content: 'hello',
            },
            finish_reason: null,
          },
        ],
        usage: null,
      }
      yield {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
        usage: null,
      }
    }

    it('app イベント形式の SSE を返す', async () => {
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockResolvedValue({
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: createStreamChunk,
      })

      const res = await chatRoutes.request('/api/chat/stream', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      const body = await res.text()

      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(body).toContain('"event":"delta"')
      expect(body).toContain('"event":"finish"')
      expect(body).toContain('data: [DONE]')
    })

    it('responses モードの SSE を既存イベント契約へ正規化する', async () => {
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockResolvedValue({
        controller: { abort: vi.fn() },
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'response.created',
            sequence_number: 0,
            response: {
              id: 'resp_1',
              created_at: 1700000000,
              model: 'gpt-test',
            },
          }
          yield {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: 'item_1',
            output_index: 0,
            content_index: 0,
            delta: 'answer',
            logprobs: [],
          }
          yield {
            type: 'response.completed',
            sequence_number: 2,
            response: {
              id: 'resp_1',
              created_at: 1700000000,
              model: 'gpt-test',
              usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 20,
                output_tokens_details: { reasoning_tokens: 5 },
                total_tokens: 30,
              },
            },
          }
        },
      })

      const res = await chatRoutes.request('/api/chat/stream', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          apiMode: 'responses',
          messages: [],
        }),
      })

      const body = await res.text()

      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(body).toContain('"event":"delta"')
      expect(body).toContain('"content":"answer"')
      expect(body).toContain('"event":"finish"')
      expect(body).toContain('"event":"usage"')
    })

    it('必須 header がない場合は 400 を返す', async () => {
      const { chatRoutes } = await importSubject()

      const res = await chatRoutes.request('/api/chat/stream', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body).toHaveProperty('code', 'VALIDATION_ERROR')
    })

    it('不正な body は公開契約の validation error 形式で 400 を返す', async () => {
      const { chatRoutes } = await importSubject()

      const res = await chatRoutes.request('/api/chat/stream', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: '',
          messages: [],
        }),
      })

      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: "Invalid request body 'model'",
        code: 'VALIDATION_ERROR',
      })
    })

    it('production の upstream エラー時は詳細を隠す', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockRejectedValue(new Error('Connection refused'))

      const res = await chatRoutes.request('/api/chat/stream', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
        }),
      })

      expect(res.status).toBe(502)
      await expect(res.json()).resolves.toEqual({
        error: 'Upstream error',
        code: 'UPSTREAM_ERROR',
      })
    })
  })

  describe('/api/chat/sessions', () => {
    const conversation = {
      id: 'conversation-1',
      title: 'hello',
      messages: [
        {
          id: 'message-user-1',
          role: 'user',
          content: 'hello',
          metadata: {
            model: 'gpt-test',
          },
        },
      ],
    }

    const createStreamChunk = async function* () {
      yield {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              content: 'hello',
            },
            finish_reason: null,
          },
        ],
        usage: null,
      }
      yield {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
        usage: null,
      }
    }

    const waitForCompletedSession = async (
      chatRoutes: Awaited<ReturnType<typeof importSubject>>['chatRoutes'],
      sessionId: string
    ) => {
      await vi.waitFor(async () => {
        const res = await chatRoutes.request(`/api/chat/sessions/${sessionId}`)
        const body = (await res.json()) as { session: { status: string } }
        expect(body.session.status).toBe('completed')
      })
    }

    it('session を作成し、SSE events で replay できる', async () => {
      const { chatRoutes, completionsMock } = await importSubject()
      completionsMock.mockResolvedValue({
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: createStreamChunk,
      })

      const startRes = await chatRoutes.request('/api/chat/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          conversation,
          assistantMessageId: 'message-assistant-1',
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      expect(startRes.status).toBe(200)
      const { sessionId } = (await startRes.json()) as { sessionId: string }
      await waitForCompletedSession(chatRoutes, sessionId)
      const eventsRes = await chatRoutes.request(`/api/chat/sessions/${sessionId}/events`)
      const body = await eventsRes.text()

      expect(eventsRes.headers.get('content-type')).toContain('text/event-stream')
      expect(body).toContain('event: user_message')
      expect(body).toContain('event: assistant_delta')
      expect(body).toContain('event: assistant_finish')
      expect(body).toContain('event: done')
    })

    it('ログイン時は terminal 後に会話を保存する', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://example')
      const { chatRoutes, completionsMock, upsertConversationMock } = await importSubject()
      completionsMock.mockResolvedValue({
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: createStreamChunk,
      })

      const startRes = await chatRoutes.request('/api/chat/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          conversation,
          assistantMessageId: 'message-assistant-1',
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      const { sessionId } = (await startRes.json()) as { sessionId: string }

      await waitForCompletedSession(chatRoutes, sessionId)
      const eventsRes = await chatRoutes.request(`/api/chat/sessions/${sessionId}/events`)
      await eventsRes.text()

      expect(upsertConversationMock).toHaveBeenCalledWith(
        'postgres://example',
        'test@example.com',
        expect.objectContaining({
          id: 'conversation-1',
          messages: expect.arrayContaining([
            expect.objectContaining({
              id: 'message-assistant-1',
              role: 'assistant',
              content: 'hello',
            }),
          ]),
        })
      )
    })

    it('未ログイン時は terminal 後に会話を保存しない', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://example')
      const { chatRoutes, completionsMock, getSignedCookieMock, upsertConversationMock } = await importSubject()
      getSignedCookieMock.mockResolvedValue(null)
      completionsMock.mockResolvedValue({
        controller: { abort: vi.fn() },
        [Symbol.asyncIterator]: createStreamChunk,
      })

      const startRes = await chatRoutes.request('/api/chat/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': 'api-key',
          'base-url': 'https://example.com',
        },
        body: JSON.stringify({
          conversation,
          assistantMessageId: 'message-assistant-1',
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      const { sessionId } = (await startRes.json()) as { sessionId: string }

      await waitForCompletedSession(chatRoutes, sessionId)
      const eventsRes = await chatRoutes.request(`/api/chat/sessions/${sessionId}/events`)
      await eventsRes.text()

      expect(upsertConversationMock).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/chat/completions (stub)', () => {
    it('非 stream で chatStub.completions を返す', async () => {
      vi.useFakeTimers()
      const { chatRoutes, chatStubCompletionsMock } = await importSubject()
      chatStubCompletionsMock.mockResolvedValue({ id: 'stub-completion' })

      const pending = chatRoutes.request('/api/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
          stream: false,
        }),
      })

      await vi.advanceTimersByTimeAsync(3000)
      const res = await pending

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ id: 'stub-completion' })
      expect(chatStubCompletionsMock).toHaveBeenCalledWith('gpt-test', 'response content')
    })

    it('stream で chatStub.streamCompletions を呼ぶ', async () => {
      vi.useFakeTimers()
      const { chatRoutes, chatStubStreamCompletionsMock } = await importSubject()
      chatStubStreamCompletionsMock.mockImplementation(async ({ onChunk }) => {
        await onChunk?.({
          id: 'chunk-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              delta: {
                content: 'hello',
              },
              finish_reason: null,
            },
          ],
          usage: null,
        })
      })

      const pending = chatRoutes.request('/api/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [],
          stream: true,
        }),
      })

      await vi.advanceTimersByTimeAsync(3000)
      const res = await pending
      const body = await res.text()

      expect(body).toContain('data: {')
      expect(body).toContain('data: [DONE]')
    })
  })
})
