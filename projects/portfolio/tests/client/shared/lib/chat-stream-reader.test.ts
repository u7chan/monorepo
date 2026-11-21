import { afterEach, describe, expect, it, vi } from 'vitest'
import { readChatStream } from '#/client/shared/lib/chat-stream-reader'

const encoder = new TextEncoder()

const createStream = (chunks: string[], { stallAfter }: { stallAfter?: number } = {}) =>
  ({
    getReader: () => {
      let index = 0

      return {
        read: async () => {
          if (stallAfter !== undefined && index >= stallAfter) {
            return new Promise<never>(() => {})
          }

          if (index >= chunks.length) {
            return { done: true, value: undefined }
          }

          return { done: false, value: encoder.encode(chunks[index++]) }
        },
        cancel: async () => {},
      }
    },
  }) as unknown as ReadableStream<Uint8Array>

const deltaEvent = (content: string) =>
  `data: ${JSON.stringify({ id: 'evt-1', created: 1, model: 'model-a', event: 'delta', content })}\n`

const finishEvent = () =>
  `data: ${JSON.stringify({ id: 'evt-2', created: 1, model: 'model-a', event: 'finish', finishReason: 'stop' })}\n`

describe('readChatStream', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('行の分割をまたいでも content を積み上げて finish を通知する', async () => {
    const onEvent = vi.fn()
    const payload = JSON.stringify({ id: 'evt-1', created: 1, model: 'model-a', event: 'delta', content: 'hello' })
    const stream = createStream([
      `data: ${payload.slice(0, 16)}`,
      `${payload.slice(16)}\n`,
      finishEvent(),
      'data: [DONE]\n',
    ])

    const result = await readChatStream(stream, { onEvent })

    expect(result.state.content).toBe('hello')
    expect(result.receivedFinish).toBe(true)
    expect(result.receivedDone).toBe(true)
    expect(result.error).toBeNull()
    expect(onEvent.mock.calls.map(([event]) => event.event)).toEqual(['delta', 'finish'])
  })

  it('エラーペイロードを受け取ると error を返して読み取りを止める', async () => {
    const onEvent = vi.fn()
    const stream = createStream([
      deltaEvent('partial'),
      `data: ${JSON.stringify({ code: 'RATE_LIMITED', message: 'retry later', retryable: true })}\n`,
      deltaEvent('ignored'),
    ])

    const result = await readChatStream(stream, { onEvent })

    expect(result.error).toEqual({ code: 'RATE_LIMITED', message: 'retry later', retryable: true })
    expect(result.state.content).toBe('partial')
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('idleTimeoutMs を過ぎて応答が止まると idleTimedOut を返す', async () => {
    vi.useFakeTimers()
    const stream = createStream([deltaEvent('tick')], { stallAfter: 1 })

    const promise = readChatStream(stream, { idleTimeoutMs: 30_000 })
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await promise

    expect(result.idleTimedOut).toBe(true)
    expect(result.state.content).toBe('tick')
  })
})
