import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFileSyncMock = vi.fn((filePath: string) =>
  filePath.includes('reasoning') ? 'reasoning content' : 'response content'
)

const importSubject = async () => {
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

const createStreamChunk = async function* () {
  yield {
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
  }
}

describe('chatRoutes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useRealTimers()
  })

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
        stream: false,
      }),
    })

    expect(res.status).toBe(400)
  })

  it('fakemode では base-url をローカル endpoint に置き換える', async () => {
    vi.stubEnv('SERVER_PORT', '3456')
    const { chatRoutes, completionsMock } = await importSubject()
    completionsMock.mockResolvedValue({ id: 'completion-1' })

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
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(completionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:3456/api',
      }),
      expect.objectContaining({
        model: 'gpt-test',
      })
    )
  })

  it('stream=false の場合は JSON を返す', async () => {
    const { chatRoutes, completionsMock } = await importSubject()
    completionsMock.mockResolvedValue({ id: 'completion-1', choices: [] })

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
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ id: 'completion-1', choices: [] })
  })

  it('stream=true の場合は SSE で [DONE] を返す', async () => {
    const { chatRoutes, completionsMock } = await importSubject()
    completionsMock.mockResolvedValue({
      controller: { abort: vi.fn() },
      [Symbol.asyncIterator]: createStreamChunk,
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
        stream: true,
      }),
    })

    const body = await res.text()

    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(body).toContain('data: {')
    expect(body).toContain('data: [DONE]')
  })

  it('stub endpoint は非 stream で chatStub.completions を返す', async () => {
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

  it('stub endpoint は stream で chatStub.streamCompletions を呼ぶ', async () => {
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
