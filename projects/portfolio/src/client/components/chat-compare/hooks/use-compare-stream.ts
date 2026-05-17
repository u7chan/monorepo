import { hc } from 'hono/client'
import { useCallback, useRef } from 'react'
import { parseChatStreamEvent, updateChatStream } from '#/client/components/chat/hooks/chat-response'
import type { AppType } from '#/server/app.d'
import type { ApiChatMessage, ChatUsage } from '#/types'
import type { CompareSettings } from './use-compare-settings'
import type { ModelStreamState } from './use-compare-state'

const client = hc<AppType>('/')

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
}

export function useCompareStream() {
  const abortControllerRef = useRef<AbortController | null>(null)

  const cancelAll = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
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

      const models = selectedModels

      const controller = new AbortController()
      abortControllerRef.current = controller

      const header = {
        'api-key': settings.apiKey,
        'base-url': settings.baseURL,
      }

      const promises = models.map((model) =>
        runModelStream(
          model,
          header,
          {
            apiMode: settings.apiMode,
            model,
            messages: [...modelStates[model].messages, userMessage],
          },
          controller.signal,
          (content, reasoningContent) => callbacks.onStreamContent(model, content, reasoningContent),
          (result) => callbacks.onStreamDone(model, result),
          (error) => callbacks.onStreamError(model, error)
        )
      )

      await Promise.allSettled(promises)
    },
    []
  )

  return { submitCompare, cancelAll }
}

async function runModelStream(
  model: string,
  header: { 'api-key': string; 'base-url': string },
  body: {
    apiMode: string
    model: string
    messages: ApiChatMessage[]
  },
  signal: AbortSignal,
  onContent: (content: string, reasoningContent: string) => void,
  onDone: (result: { finishReason: string; usage: ChatUsage | null; responseTimeMs: number; content: string }) => void,
  onError: (error: string) => void
): Promise<void> {
  const startTime = Date.now()

  try {
    const res = await client.api.chat.stream.$post(
      {
        header,
        json: body,
      } as never,
      { init: { signal } }
    )

    if (!res.ok) {
      const errorData = (await res.json()) as { error?: string }
      onError(errorData?.error || `HTTP ${res.status}`)
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      onError('Failed to get response reader')
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
          running = false
          break
        }

        try {
          const event = parseChatStreamEvent(jsonStr)
          accumulated = updateChatStream(accumulated, event)

          if (event.event === 'delta') {
            onContent(accumulated.content, accumulated.reasoningContent)
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

    if (receivedFinish) {
      const responseTimeMs = Date.now() - startTime
      onDone({
        finishReason,
        usage,
        responseTimeMs,
        content: accumulated.content,
      })
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    onError(error instanceof Error ? error.message : 'Unknown error')
  }
}
