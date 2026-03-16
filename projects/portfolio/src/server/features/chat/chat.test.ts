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

  const { chat } = await import('./chat')

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
        mcpServerURLs: 'https://mcp.example.com',
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

  it('custom fetch が既存 header を保持して mcp-server-urls を追加する', async () => {
    const { chat, completionsCreateMock, constructorOptionsSpy } = await importSubject()
    completionsCreateMock.mockResolvedValue({ id: 'completion-1' })

    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await chat.completions(
      {
        apiKey: 'api-key',
        baseURL: 'https://example.com',
        mcpServerURLs: 'https://mcp.example.com',
      },
      {
        model: 'gpt-4.1',
        messages: [{ role: 'system', content: 'You are a tester.' }],
        stream: false,
      }
    )

    const constructorOptions = constructorOptionsSpy.mock.calls[0]?.[0] as {
      fetch: (url: string, options?: RequestInit) => Promise<unknown>
    }

    await constructorOptions.fetch('https://example.com/v1/chat/completions', {
      headers: new Headers({
        Authorization: 'Bearer api-key',
      }),
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/v1/chat/completions',
      expect.objectContaining({
        headers: {
          authorization: 'Bearer api-key',
          'mcp-server-urls': 'https://mcp.example.com',
        },
      })
    )
  })
})
