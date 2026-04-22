import { beforeEach, describe, expect, it, vi } from 'vitest'

const importSubject = async () => {
  const completionsCreateMock = vi.fn()
  const responsesCreateMock = vi.fn()
  const constructorOptionsSpy = vi.fn()

  vi.doMock('openai', () => ({
    default: class OpenAI {
      chat = {
        completions: {
          create: completionsCreateMock,
        },
      }
      responses = {
        create: responsesCreateMock,
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
    responsesCreateMock,
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
        apiMode: 'chat_completions',
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
        apiMode: 'chat_completions',
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

  it('responses モードでは assistant 履歴と画像入力を Responses input へ変換する', async () => {
    const { chat, responsesCreateMock } = await importSubject()
    responsesCreateMock.mockResolvedValue({ id: 'resp-1' })

    await chat.completions(
      {
        apiKey: 'api-key',
        baseURL: 'https://example.com',
      },
      {
        apiMode: 'responses',
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: 'You are a tester.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this image' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
          },
          { role: 'assistant', content: 'previous answer' },
        ],
        temperature: 0.4,
        maxTokens: 256,
        reasoningEffort: 'high',
        stream: false,
      }
    )

    expect(responsesCreateMock).toHaveBeenCalledWith({
      model: 'gpt-4.1',
      input: [
        {
          type: 'message',
          role: 'system',
          content: 'You are a tester.',
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this image' },
            { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' },
          ],
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'previous answer',
        },
      ],
      temperature: 0.4,
      max_output_tokens: 256,
      reasoning: { effort: 'high' },
      stream: false,
    })
  })
})
