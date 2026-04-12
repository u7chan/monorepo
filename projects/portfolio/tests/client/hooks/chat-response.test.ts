import {
  parseChatCompletionResponse,
  parseChatCompletionStreamChunk,
  toChatCompletionResult,
  updateChatStream,
} from '#/client/components/chat/hooks/chat-response'
import { describe, expect, it } from 'vitest'

describe('chat-response helpers', () => {
  it('non-stream response を共有型で正規化できる', () => {
    const response = parseChatCompletionResponse({
      model: 'gpt-test',
      choices: [
        {
          message: {
            content: 'assistant answer',
            reasoning_content: 'thinking',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        reasoning_tokens: 5,
      },
    })

    expect(toChatCompletionResult(response)).toEqual({
      model: 'gpt-test',
      finishReason: 'stop',
      message: {
        content: 'assistant answer',
        reasoningContent: 'thinking',
      },
      responseTimeMs: 0,
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        reasoningTokens: 5,
      },
    })
  })

  it('non-stream response の content=null を結果なしとして扱える', () => {
    const response = parseChatCompletionResponse({
      model: 'gpt-test',
      choices: [
        {
          message: {
            content: null,
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: null,
    })

    expect(toChatCompletionResult(response)).toBeNull()
  })

  it('stream chunk を蓄積して finish reason と usage を取り出せる', () => {
    const firstChunk = parseChatCompletionStreamChunk(
      JSON.stringify({
        model: 'gpt-stream',
        choices: [
          {
            delta: {
              reasoning_content: 'thinking',
            },
            finish_reason: null,
          },
        ],
      })
    )
    const secondChunk = parseChatCompletionStreamChunk(
      JSON.stringify({
        model: 'gpt-stream',
        choices: [
          {
            delta: {
              content: 'answer',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 22,
          total_tokens: 33,
          completion_tokens_details: {
            reasoning_tokens: 7,
          },
        },
      })
    )

    const accumulated = updateChatStream({ content: '', reasoning_content: '' }, firstChunk)
    const completed = updateChatStream(accumulated.stream, secondChunk)

    expect(accumulated.stream).toEqual({
      content: '',
      reasoning_content: 'thinking',
    })
    expect(completed.stream).toEqual({
      content: 'answer',
      reasoning_content: 'thinking',
    })
    expect(completed.finishReason).toBe('stop')
    expect(completed.model).toBe('gpt-stream')
    expect(completed.usage).toEqual({
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      reasoningTokens: 7,
    })
  })
})
