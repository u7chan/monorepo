import { parseChatStreamEvent, updateChatStream } from '#/client/components/chat/hooks/chat-response'
import { describe, expect, it } from 'vitest'

describe('chat-response helpers', () => {
  it('delta イベントで content を蓄積できる', () => {
    const state = { content: '', reasoningContent: '' }

    const event = parseChatStreamEvent(
      JSON.stringify({
        event: 'delta',
        id: 'chunk-1',
        created: 1700000000,
        model: 'gpt-test',
        content: 'hello',
      })
    )

    const next = updateChatStream(state, event)

    expect(next).toEqual({
      content: 'hello',
      reasoningContent: '',
    })
  })

  it('delta イベントで reasoningContent を蓄積できる', () => {
    const state = { content: '', reasoningContent: '' }

    const event = parseChatStreamEvent(
      JSON.stringify({
        event: 'delta',
        id: 'chunk-1',
        created: 1700000000,
        model: 'gpt-test',
        reasoningContent: 'thinking',
      })
    )

    const next = updateChatStream(state, event)

    expect(next).toEqual({
      content: '',
      reasoningContent: 'thinking',
    })
  })

  it('finish, usage イベントではストリーム状態が変わらない', () => {
    const state = { content: 'hello', reasoningContent: 'thinking' }

    const finishEvent = parseChatStreamEvent(
      JSON.stringify({
        event: 'finish',
        id: 'chunk-2',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
      })
    )

    const usageEvent = parseChatStreamEvent(
      JSON.stringify({
        event: 'usage',
        id: 'chunk-3',
        created: 1700000000,
        model: 'gpt-test',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          reasoningTokens: 5,
        },
      })
    )

    expect(updateChatStream(state, finishEvent)).toEqual(state)
    expect(updateChatStream(state, usageEvent)).toEqual(state)
  })

  it('複数の delta イベントを順次蓄積できる', () => {
    let state = { content: '', reasoningContent: '' }

    const events = [
      {
        event: 'delta',
        id: 'chunk-1',
        created: 1700000000,
        model: 'gpt-stream',
        reasoningContent: 'think',
      },
      {
        event: 'delta',
        id: 'chunk-2',
        created: 1700000000,
        model: 'gpt-stream',
        reasoningContent: 'ing',
      },
      {
        event: 'delta',
        id: 'chunk-3',
        created: 1700000000,
        model: 'gpt-stream',
        content: 'answer',
      },
    ]

    for (const raw of events) {
      const event = parseChatStreamEvent(JSON.stringify(raw))
      state = updateChatStream(state, event)
    }

    expect(state).toEqual({
      content: 'answer',
      reasoningContent: 'thinking',
    })
  })

  it('finish イベントから finishReason を取得できる', () => {
    const event = parseChatStreamEvent(
      JSON.stringify({
        event: 'finish',
        id: 'chunk-finish',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
      })
    )

    expect(event.event).toBe('finish')
    if (event.event === 'finish') {
      expect(event.finishReason).toBe('stop')
    }
  })

  it('usage イベントから token 情報を取得できる', () => {
    const event = parseChatStreamEvent(
      JSON.stringify({
        event: 'usage',
        id: 'chunk-usage',
        created: 1700000000,
        model: 'gpt-test',
        usage: {
          promptTokens: 11,
          completionTokens: 22,
          totalTokens: 33,
          reasoningTokens: 7,
        },
      })
    )

    expect(event.event).toBe('usage')
    if (event.event === 'usage') {
      expect(event.usage).toEqual({
        promptTokens: 11,
        completionTokens: 22,
        totalTokens: 33,
        reasoningTokens: 7,
      })
    }
  })
})
