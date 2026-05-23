import { hc } from 'hono/client'
import { useCallback, useRef } from 'react'
import { parseChatStreamEvent, updateChatStream } from '#/client/components/chat/hooks/chat-response'
import type { AppType } from '#/server/app.d'
import type { ApiChatMessage, ChatUsage } from '#/types'
import type { CompareSettings } from './use-compare-settings'
import type { ModelStreamState } from './use-compare-state'

const client = hc<AppType>('/')

const IDLE_TIMEOUT_MS = 30_000

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

interface ModelCallbacks {
  onStreamContent: (content: string, reasoningContent: string) => void
  onStreamDone: (result: {
    finishReason: string
    usage: ChatUsage | null
    responseTimeMs: number
    content: string
  }) => void
  onStreamError: (error: string) => void
}

interface SubmitModelArgs {
  settings: CompareSettings
  modelState: ModelStreamState
  userMessage?: ApiChatMessage
  callbacks: ModelCallbacks
}

export function useCompareStream() {
  const controllerMapRef = useRef<Map<string, AbortController>>(new Map())

  const cancelModel = useCallback((model: string) => {
    const controller = controllerMapRef.current.get(model)
    controllerMapRef.current.delete(model)
    controller?.abort()
  }, [])

  const cancelAll = useCallback(() => {
    for (const controller of controllerMapRef.current.values()) {
      controller.abort()
    }
    controllerMapRef.current.clear()
  }, [])

  const submitCompare = useCallback(
    (
      settings: CompareSettings,
      modelStates: Record<string, ModelStreamState>,
      selectedModels: string[],
      userMessage: ApiChatMessage,
      callbacks: StreamCallbacks
    ) => {
      if (selectedModels.length === 0) return

      const header = {
        'api-key': settings.apiKey,
        'base-url': settings.baseURL,
      }

      for (const model of selectedModels) {
        const controller = new AbortController()
        controllerMapRef.current.set(model, controller)

        const messages = modelStates[model] ? [...modelStates[model].messages, userMessage] : [userMessage]

        runModelStream(
          model,
          header,
          { apiMode: settings.apiMode, model, messages },
          controller.signal,
          (content, reasoningContent) => callbacks.onStreamContent(model, content, reasoningContent),
          (result) => callbacks.onStreamDone(model, result),
          (error) => callbacks.onStreamError(model, error)
        ).finally(() => {
          controllerMapRef.current.delete(model)
        })
      }
    },
    []
  )

  const submitModel = useCallback((args: SubmitModelArgs) => {
    const { settings, modelState, userMessage, callbacks } = args
    const { model } = modelState

    controllerMapRef.current.get(model)?.abort()
    controllerMapRef.current.delete(model)

    const controller = new AbortController()
    controllerMapRef.current.set(model, controller)

    const header = {
      'api-key': settings.apiKey,
      'base-url': settings.baseURL,
    }

    const messages = userMessage ? [...modelState.messages, userMessage] : modelState.messages

    return runModelStream(
      model,
      header,
      { apiMode: settings.apiMode, model, messages },
      controller.signal,
      callbacks.onStreamContent,
      callbacks.onStreamDone,
      callbacks.onStreamError
    ).finally(() => {
      controllerMapRef.current.delete(model)
    })
  }, [])

  return { submitCompare, submitModel, cancelModel, cancelAll }
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
  let timedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

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

    const startIdleTimer = () => {
      clearIdleTimer()
      idleTimer = setTimeout(() => {
        timedOut = true
        running = false
        reader.cancel().catch(() => {})
      }, IDLE_TIMEOUT_MS)
    }

    startIdleTimer()

    while (running) {
      const { done, value } = await reader.read()

      clearIdleTimer()

      if (done) break

      buffer += decoder.decode(value, { stream: true })
      while (true) {
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

      if (running) {
        startIdleTimer()
      }
    }

    clearIdleTimer()

    if (timedOut) {
      onError('Response timed out')
    } else if (receivedFinish) {
      const responseTimeMs = Date.now() - startTime
      onDone({
        finishReason,
        usage,
        responseTimeMs,
        content: accumulated.content,
      })
    } else if (running) {
      onError('Stream ended without finish reason')
    }
  } catch (error) {
    clearIdleTimer()
    if (error instanceof Error && error.name === 'AbortError') return
    onError(error instanceof Error ? error.message : 'Unknown error')
  }
}
