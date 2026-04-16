import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../helpers/mock-logger'

const readFileSyncMock = vi.fn((filePath: string) =>
  filePath.includes('reasoning') ? 'reasoning content' : 'response content'
)

const importSubject = async () => {
  mockLogger()
  const completionsMock = vi.fn()
  const chatStubCompletionsMock = vi.fn()
  const chatStubStreamCompletionsMock = vi.fn()
  const getSignedCookieMock = vi.fn().mockResolvedValue('test@example.com')

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

  const { chatRoutes } = await import('#/server/routes/chat')

  return {
    chatRoutes,
    completionsMock,
    chatStubCompletionsMock,
    chatStubStreamCompletionsMock,
  }
}

describe('chatRoutes', () => {
  beforeEach(() => {
    vi.resetModules()
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
