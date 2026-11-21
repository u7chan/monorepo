import { hc } from 'hono/client'
import { useCallback, useRef } from 'react'
import { readChatError, unavailableChatError } from '#/client/shared/lib/chat-error'
import { readChatStream } from '#/client/shared/lib/chat-stream-reader'
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

  try {
    const res = await client.api.chat.stream.$post(
      {
        header,
        json: body,
      } as never,
      { init: { signal } }
    )

    if (!res.ok) {
      const error = await readChatError(res)
      onError(error.message)
      return
    }

    if (!res.body) {
      onError('Failed to get response reader')
      return
    }

    let finishReason = ''
    let usage: ChatUsage | null = null

    const read = await readChatStream(res.body, {
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      // 比較ストリームは従来、壊れた行を無視して残りのイベントを継続していた。
      ignoreParseErrors: true,
      onEvent: (event, stream) => {
        if (event.event === 'delta') {
          onContent(stream.content, stream.reasoningContent)
        }
        if (event.event === 'finish') {
          finishReason = event.finishReason
        }
        if (event.event === 'usage') {
          usage = event.usage
        }
      },
    })

    if (read.idleTimedOut) {
      onError(unavailableChatError().message)
    } else if (read.error) {
      onError(read.error.message)
    } else if (read.receivedFinish) {
      onDone({
        finishReason,
        usage,
        responseTimeMs: Date.now() - startTime,
        content: read.state.content,
      })
    } else if (!read.receivedDone) {
      onError('Stream ended without finish reason')
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    onError(unavailableChatError().message)
  }
}
