import type { ChatError, ChatStreamEvent } from '#/types/chat-api'
import { isChatStreamError, parseChatStreamPayload, updateChatStream, type ChatStreamState } from './chat-stream'

const IDLE_TIMEOUT = Symbol('chat-stream-idle-timeout')

export interface ChatStreamReadResult {
  state: ChatStreamState
  receivedFinish: boolean
  receivedDone: boolean
  error: ChatError | null
  idleTimedOut: boolean
}

export interface ReadChatStreamOptions {
  idleTimeoutMs?: number
  /** 壊れた `data:` 行を無視する。従来ストリームは例外として呼び出し側へ渡していたため既定は false。 */
  ignoreParseErrors?: boolean
  onEvent?: (event: ChatStreamEvent, state: ChatStreamState) => void
}

/**
 * SSE の `data:` 行を解釈して ChatStreamState を積み上げる。
 * 終了理由は呼び出し側で扱いが違うので、例外ではなく result で返す。
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  { idleTimeoutMs = 0, ignoreParseErrors = false, onEvent }: ReadChatStreamOptions = {}
): Promise<ChatStreamReadResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const result: ChatStreamReadResult = {
    state: { content: '', reasoningContent: '' },
    receivedFinish: false,
    receivedDone: false,
    error: null,
    idleTimedOut: false,
  }

  let buffer = ''
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  // 無応答で固まるのを防ぐため、read 自体をタイムアウトと競争させる。
  // 負けた read は cancel で畳むので、ここでは reject ではなく sentinel を返す。
  const readWithIdleTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array> | typeof IDLE_TIMEOUT> => {
    if (idleTimeoutMs <= 0) {
      return reader.read()
    }

    return Promise.race([
      reader.read(),
      new Promise<typeof IDLE_TIMEOUT>((resolve) => {
        idleTimer = setTimeout(() => resolve(IDLE_TIMEOUT), idleTimeoutMs)
      }),
    ])
  }

  try {
    while (true) {
      const read = await readWithIdleTimeout()
      clearIdleTimer()

      if (read === IDLE_TIMEOUT) {
        result.idleTimedOut = true
        // cancel の完了を待つと、underlying source の cancel が pending のままのストリームでここが固まる。
        // タイムアウトは呼び出し側へ返すべき結果なので、片付けは投げっ放しにする。
        void reader.cancel().catch(() => undefined)
        break
      }

      if (read.done) break

      buffer += decoder.decode(read.value, { stream: true })

      let finished = false
      while (!finished) {
        const index = buffer.indexOf('\n')
        if (index === -1) break

        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        finished = consumeDataLine(line, result, ignoreParseErrors, onEvent)
      }

      if (finished) break
    }
  } finally {
    clearIdleTimer()
  }

  return result
}

function consumeDataLine(
  line: string,
  result: ChatStreamReadResult,
  ignoreParseErrors: boolean,
  onEvent: ReadChatStreamOptions['onEvent']
): boolean {
  if (!line.startsWith('data: ')) return false

  const payload = line.replace(/^data:\s*/, '')
  if (payload === '[DONE]') {
    result.receivedDone = true
    return true
  }

  let event: ChatStreamEvent | ChatError
  try {
    event = parseChatStreamPayload(payload)
  } catch (error) {
    if (ignoreParseErrors) return false
    throw error
  }

  if (isChatStreamError(event)) {
    result.error = event
    return true
  }

  result.state = updateChatStream(result.state, event)
  if (event.event === 'finish') {
    result.receivedFinish = true
  }
  onEvent?.(event, result.state)

  return false
}
