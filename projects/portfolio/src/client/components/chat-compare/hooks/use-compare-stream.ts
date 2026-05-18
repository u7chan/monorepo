import { hc } from 'hono/client'
import { type MutableRefObject, useCallback, useRef } from 'react'
import { parseChatStreamEvent, updateChatStream } from '#/client/components/chat/hooks/chat-response'
import type { AppType } from '#/server/app.d'
import type { ApiChatMessage, ChatUsage } from '#/types'
import type { CompareSettings } from './use-compare-settings'
import type { ModelStreamState } from './use-compare-state'

const client = hc<AppType>('/')

export const STREAM_IDLE_TIMEOUT_MS = 60_000
export const STREAM_MAX_RETRY_ATTEMPTS = 1

interface StreamCallbacks {
  onStreamContent: (model: string, content: string, reasoningContent: string) => void
  onStreamDone: (
    model: string,
    result: {
      finishReason: string
      usage: ChatUsage | null
      responseTimeMs: number
      content: string
    }
  ) => void
  onStreamError: (model: string, error: string) => void
  onStreamRetry: (model: string, attempt: number) => void
}

interface ModelRuntime {
  controller: AbortController
  timerId: ReturnType<typeof setTimeout> | null
  cancelled: boolean
  timedOut: boolean
}

export function useCompareStream() {
  const runtimesRef = useRef<Map<string, ModelRuntime>>(new Map())

  const cancelAll = useCallback(() => {
    for (const runtime of runtimesRef.current.values()) {
      runtime.cancelled = true
      if (runtime.timerId) {
        clearTimeout(runtime.timerId)
        runtime.timerId = null
      }
      runtime.controller.abort()
    }
    runtimesRef.current.clear()
  }, [])

  const submitCompare = useCallback(
    async (
      settings: CompareSettings,
      modelStates: Record<string, ModelStreamState>,
      selectedModels: string[],
      userMessage: ApiChatMessage,
      callbacks: StreamCallbacks
    ) => {
      if (selectedModels.length === 0) return

      cancelAll()

      const header = {
        'api-key': settings.apiKey,
        'base-url': settings.baseURL,
      }

      const promises = selectedModels.map((model) =>
        runModelStreamWithRetry(
          model,
          header,
          {
            apiMode: settings.apiMode,
            model,
            messages: [...(modelStates[model]?.messages ?? []), userMessage],
          },
          callbacks,
          runtimesRef,
          0
        )
      )

      await Promise.allSettled(promises)
      runtimesRef.current.clear()
    },
    [cancelAll]
  )

  return { submitCompare, cancelAll }
}

async function runModelStreamWithRetry(
  model: string,
  header: { 'api-key': string; 'base-url': string },
  body: {
    apiMode: string
    model: string
    messages: ApiChatMessage[]
  },
  callbacks: StreamCallbacks,
  runtimesRef: MutableRefObject<Map<string, ModelRuntime>>,
  attempt: number
): Promise<void> {
  const startTime = Date.now()
  const controller = new AbortController()
  const runtime: ModelRuntime = {
    controller,
    timerId: null,
    cancelled: false,
    timedOut: false,
  }

  const clearIdleTimer = () => {
    if (runtime.timerId) {
      clearTimeout(runtime.timerId)
      runtime.timerId = null
    }
  }

  const scheduleIdleTimer = () => {
    clearIdleTimer()
    runtime.timerId = setTimeout(() => {
      runtime.timedOut = true
      runtime.controller.abort()
    }, STREAM_IDLE_TIMEOUT_MS)
  }

  runtimesRef.current.set(model, runtime)
  scheduleIdleTimer()

  try {
    const res = await client.api.chat.stream.$post(
      {
        header,
        json: body,
      } as never,
      { init: { signal: runtime.controller.signal } }
    )

    if (!res.ok) {
      clearIdleTimer()
      const errorData = (await res.json()) as { error?: string }
      callbacks.onStreamError(model, errorData?.error || `HTTP ${res.status}`)
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      clearIdleTimer()
      callbacks.onStreamError(model, 'Failed to get response reader')
      return
    }

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let accumulated = { content: '', reasoningContent: '' }
    let finishReason = ''
    let usage: ChatUsage | null = null
    let receivedFinish = false
    let running = true

    while (running) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      while (running) {
        const idx = buffer.indexOf('\n')
        if (idx === -1) break

        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data: ')) continue

        const jsonStr = line.replace(/^data:\s*/, '')
        if (jsonStr === '[DONE]') {
          scheduleIdleTimer()
          running = false
          break
        }

        try {
          const event = parseChatStreamEvent(jsonStr)
          accumulated = updateChatStream(accumulated, event)
          scheduleIdleTimer()

          if (event.event === 'delta') {
            callbacks.onStreamContent(model, accumulated.content, accumulated.reasoningContent)
          }
          if (event.event === 'finish') {
            finishReason = event.finishReason
            receivedFinish = true
          }
          if (event.event === 'usage') {
            usage = event.usage
          }
        } catch {
          // パース失敗は無視
        }
      }
    }

    clearIdleTimer()

    if (receivedFinish) {
      callbacks.onStreamDone(model, {
        finishReason,
        usage,
        responseTimeMs: Date.now() - startTime,
        content: accumulated.content,
      })
      return
    }

    callbacks.onStreamError(model, buildIncompleteStreamError())
  } catch (error) {
    clearIdleTimer()

    if (isAbortError(error)) {
      if (runtime.cancelled) return

      if (runtime.timedOut) {
        if (attempt < STREAM_MAX_RETRY_ATTEMPTS) {
          const nextAttempt = attempt + 1
          callbacks.onStreamRetry(model, nextAttempt)
          await runModelStreamWithRetry(model, header, body, callbacks, runtimesRef, nextAttempt)
          return
        }

        callbacks.onStreamError(model, buildTimeoutError(attempt))
        return
      }

      return
    }

    callbacks.onStreamError(model, error instanceof Error ? error.message : 'Unknown error')
  } finally {
    clearIdleTimer()

    if (runtimesRef.current.get(model) === runtime) {
      runtimesRef.current.delete(model)
    }
  }
}

function buildTimeoutError(attempt: number): string {
  const seconds = STREAM_IDLE_TIMEOUT_MS / 1000

  if (attempt > 0) {
    return `${seconds}秒間応答がなかったため停止しました。${attempt}回リトライしました。`
  }

  return `${seconds}秒間応答がなかったため停止しました。`
}

function buildIncompleteStreamError(): string {
  return 'ストリームが完了イベントなしで終了しました。'
}

function isAbortError(error: unknown): error is { name: string } {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}
