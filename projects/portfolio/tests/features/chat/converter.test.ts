import { convertCompletion, convertStreamChunks } from '#/server/features/chat/converter'
import type { CompletionChunk, StreamCompletionChunk, StreamChunk } from '#/server/features/chat/transport'
import { describe, expect, it } from 'vitest'

describe('convertCompletion', () => {
  it('LiteLLM レスポンスを正規化できる', () => {
    const raw = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning_content: 'thinking',
            refusal: null,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        completion_tokens_details: {
          reasoning_tokens: 5,
        },
      },
    } as unknown as CompletionChunk

    const result = convertCompletion(raw)

    expect(result).toEqual({
      id: 'chatcmpl-abc',
      created: 1700000000,
      model: 'gpt-4.1',
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

  it('LiteLLM provider_specific_fields からの reasoning fallback', () => {
    const raw = {
      id: 'chatcmpl-fallback',
      object: 'chat.completion',
      created: 1700000001,
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'answer',
            provider_specific_fields: { reasoning_content: 'fallback thinking' },
            refusal: null,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    } as unknown as CompletionChunk

    const result = convertCompletion(raw)

    expect(result.message.reasoningContent).toBe('fallback thinking')
  })

  it('Bifrost レスポンスの reasoning を正規化��きる', () => {
    const raw = {
      id: 'chatcmpl-bifrost',
      object: 'chat.completion',
      created: 1700000002,
      model: 'claude-sonnet',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning: 'bifrost thinking',
            refusal: null,
          },
          finish_reason: 'end_turn',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 15,
        total_tokens: 20,
      },
    } as unknown as CompletionChunk

    const result = convertCompletion(raw)

    expect(result.message.reasoningContent).toBe('bifrost thinking')
    expect(result.finishReason).toBe('end_turn')
    expect(result.usage).toEqual({
      promptTokens: 5,
      completionTokens: 15,
      totalTokens: 20,
      reasoningTokens: undefined,
    })
  })

  it('Bifrost reasoning_details からの fallback', () => {
    const raw = {
      id: 'chatcmpl-bifrost-details',
      object: 'chat.completion',
      created: 1700000003,
      model: 'claude-sonnet',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning_details: [
              { type: 'text', text: 'part1' },
              { type: 'text', text: 'part2' },
            ],
            refusal: null,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    } as unknown as CompletionChunk

    const result = convertCompletion(raw)

    expect(result.message.reasoningContent).toBe('part1part2')
  })

  it('content が null の場合は空文字になる', () => {
    const raw = {
      id: 'chatcmpl-null',
      object: 'chat.completion',
      created: 1700000004,
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
          },
          finish_reason: 'tool_calls',
          logprobs: null,
        },
      ],
    } as unknown as CompletionChunk

    const result = convertCompletion(raw)

    expect(result.message.content).toBe('')
    expect(result.message.reasoningContent).toBe('')
    expect(result.usage).toBeNull()
  })
})

describe('convertStreamChunks', () => {
  const createMockStream = (chunks: StreamCompletionChunk[]): StreamChunk => {
    async function* generate() {
      for (const chunk of chunks) {
        yield chunk
      }
    }
    return generate() as unknown as StreamChunk
  }

  it('LiteLLM reasoning_content delta を delta イベントに変換する', async () => {
    const stream = createMockStream([
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'thinking' },
            finish_reason: null,
          },
        ],
        usage: null,
      } as unknown as StreamCompletionChunk,
    ])

    const events = []
    for await (const event of convertStreamChunks(stream)) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        event: 'delta',
        id: 'chunk-1',
        created: 1700000000,
        model: 'gpt-4.1',
        reasoningContent: 'thinking',
        content: undefined,
      },
    ])
  })

  it('Bifrost reasoning delta を delta イベントに変換する', async () => {
    const stream = createMockStream([
      {
        id: 'chunk-bifrost',
        object: 'chat.completion.chunk',
        created: 1700000001,
        model: 'claude-sonnet',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning: 'bifrost thinking' },
            finish_reason: null,
          },
        ],
        usage: null,
      } as unknown as StreamCompletionChunk,
    ])

    const events = []
    for await (const event of convertStreamChunks(stream)) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        event: 'delta',
        id: 'chunk-bifrost',
        created: 1700000001,
        model: 'claude-sonnet',
        reasoningContent: 'bifrost thinking',
        content: undefined,
      },
    ])
  })

  it('delta, finish, usage の順でイベントを正しく emit する', async () => {
    const stream = createMockStream([
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-stream',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
        usage: null,
      } as unknown as StreamCompletionChunk,
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-stream',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: null,
      } as unknown as StreamCompletionChunk,
      {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-stream',
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      } as unknown as StreamCompletionChunk,
    ])

    const events = []
    for await (const event of convertStreamChunks(stream)) {
      events.push(event)
    }

    expect(events).toHaveLength(3)
    expect(events[0]).toEqual({
      event: 'delta',
      id: 'chunk-1',
      created: 1700000000,
      model: 'gpt-stream',
      content: 'hello',
      reasoningContent: undefined,
    })
    expect(events[1]).toEqual({
      event: 'finish',
      id: 'chunk-2',
      created: 1700000000,
      model: 'gpt-stream',
      finishReason: 'stop',
    })
    expect(events[2]).toEqual({
      event: 'usage',
      id: 'chunk-3',
      created: 1700000000,
      model: 'gpt-stream',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        reasoningTokens: 5,
      },
    })
  })

  it('usage-only 最終チャンクで metadata を補完する', async () => {
    const stream = createMockStream([
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'gpt-stream',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
        usage: null,
      } as unknown as StreamCompletionChunk,
      // Bifrost の usage-only 最終チャンク (model/id/created が空の場合)
      {
        id: '',
        object: 'chat.completion.chunk',
        created: 0,
        model: '',
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      } as unknown as StreamCompletionChunk,
    ])

    const events = []
    for await (const event of convertStreamChunks(stream)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    // usage イベントが前のチャンクの metadata を引き���ぐ
    expect(events[1]).toEqual({
      event: 'usage',
      id: 'chunk-1',
      created: 1700000000,
      model: 'gpt-stream',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        reasoningTokens: undefined,
      },
    })
  })
})
