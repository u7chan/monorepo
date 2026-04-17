import { beforeEach, describe, expect, it, vi } from 'vitest'

const importSubject = async () => {
  const completionsCreateMock = vi.fn()
  const constructorOptionsSpy = vi.fn()

  vi.doMock('openai', () => ({
    default: class OpenAI {
      chat = {
        completions: {
          create: completionsCreateMock,
        },
      }

      constructor(options: unknown) {
        constructorOptionsSpy(options)
      }
    },
  }))

  const { chat } = await import('#/server/features/chat/chat')

  return {
    chat,
    completionsCreateMock,
    constructorOptionsSpy,
  }
}

describe('chat.completions', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('OpenAI 呼び出しにリクエストを正しく変換する', async () => {
    const { chat, completionsCreateMock } = await importSubject()
    completionsCreateMock.mockResolvedValue({ id: 'completion-1' })

    await chat.completions(
      {
        apiKey: 'api-key',
        baseURL: 'https://example.com',
      },
      {
        model: 'gpt-4.1',
        messages: [{ role: 'system', content: 'You are a tester.' }],
        temperature: 0.4,
        maxTokens: 256,
        reasoningEffort: 'high',
        stream: false,
        includeUsage: true,
      }
    )

    expect(completionsCreateMock).toHaveBeenCalledWith({
      model: 'gpt-4.1',
      messages: [{ role: 'system', content: 'You are a tester.' }],
      temperature: 0.4,
      max_tokens: 256,
      reasoning_effort: 'high',
      stream: false,
      stream_options: {
        include_usage: true,
      },
    })
  })

  it('OpenAI クライアントに apiKey と baseURL が渡される', async () => {
    const { chat, completionsCreateMock, constructorOptionsSpy } = await importSubject()
    completionsCreateMock.mockResolvedValue({ id: 'completion-1' })

    await chat.completions(
      {
        apiKey: 'api-key',
        baseURL: 'https://example.com',
      },
      {
        model: 'gpt-4.1',
        messages: [{ role: 'system', content: 'You are a tester.' }],
        stream: false,
      }
    )

    expect(constructorOptionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'api-key',
        baseURL: 'https://example.com',
      })
    )
  })
})
