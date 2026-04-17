import type { AppType } from '#/server/app.d'
import type { ApiChatMessage } from '#/types'
import type { ChatResponse, ChatUsage } from '#/types/chat-api'
import { hc } from 'hono/client'
import { useCallback, useRef, useState } from 'react'
import { type ChatStreamState, parseChatStreamEvent, updateChatStream } from './chat-response'

const client = hc<AppType>('/')

interface SubmitChatCompletionParams {
  header: {
    apiKey: string
    baseURL: string
  }
  model: string
  /** /api/chat wire 形式のメッセージ（toApiChatMessage で変換済み） */
  messages: ApiChatMessage[]
  streamMode: boolean
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

interface UseStreamProcessorParams {
  onSubmitting?: (submitting: boolean) => void
}

export function useStreamProcessor({ onSubmitting }: UseStreamProcessorParams = {}) {
  const abortControllerRef = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  const [stream, setStream] = useState<ChatStreamState | null>(null)

  const cancelStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const submitChatCompletion = useCallback(
    async ({
      header,
      model,
      messages,
      streamMode,
      temperature,
      maxTokens,
      reasoningEffort,
    }: SubmitChatCompletionParams): Promise<{ result: ChatResponse | null; responseTimeMs: number }> => {
      setLoading(true)
      abortControllerRef.current = new AbortController()
      onSubmitting?.(true)
      const requestStartTime = Date.now()

      try {
        const result = streamMode
          ? await sendStreamCompletion({
              abortController: abortControllerRef.current,
              header,
              model,
              messages,
              temperature,
              maxTokens,
              reasoningEffort,
              onStream: (stream) => setStream(stream),
            })
          : await sendNonStreamCompletion({
              abortController: abortControllerRef.current,
              header,
              model,
              messages,
              temperature,
              maxTokens,
              reasoningEffort,
            })
        const responseTimeMs = Date.now() - requestStartTime

        return { result, responseTimeMs }
      } finally {
        abortControllerRef.current = null
        setStream(null)
        setLoading(false)
        onSubmitting?.(false)
      }
    },
    [onSubmitting]
  )

  return {
    loading,
    stream,
    cancelStream,
    submitChatCompletion,
  }
}

interface SendCompletionParams {
  abortController: AbortController
  header: {
    apiKey: string
    baseURL: string
  }
  model: string
  messages: ApiChatMessage[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

const makeErrorResponse = (message: string): ChatResponse => ({
  id: '',
  created: 0,
  model: 'N/A',
  finishReason: '',
  message: { content: message, reasoningContent: '' },
  usage: null,
})

const hasAssistantOutput = ({ content, reasoningContent }: ChatResponse['message']): boolean =>
  content.length > 0 || reasoningContent.length > 0

const sendNonStreamCompletion = async (req: SendCompletionParams): Promise<ChatResponse | null> => {
  try {
    const res = await client.api.chat.$post(
      {
        header: {
          'api-key': req.header.apiKey,
          'base-url': req.header.baseURL,
        },
        json: {
          messages: req.messages,
          model: req.model,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          reasoningEffort: req.reasoningEffort,
        },
      },
      { init: { signal: req.abortController.signal } }
    )

    if (!res.ok) {
      const error = (await res.json()) as { error?: string }
      return makeErrorResponse(error?.error || JSON.stringify(error))
    }

    const data = (await res.json()) as ChatResponse
    if (!hasAssistantOutput(data.message)) return null

    return data
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return null
    throw error
  }
}

const sendStreamCompletion = async (
  req: SendCompletionParams & { onStream?: (stream: ChatStreamState) => void }
): Promise<ChatResponse | null> => {
  let accumulated: ChatStreamState = { content: '', reasoningContent: '' }
  let id = ''
  let created = 0
  let model = 'N/A'
  let finishReason = ''
  let usage: ChatUsage | null = null

  try {
    const res = await client.api.chat.stream.$post(
      {
        header: {
          'api-key': req.header.apiKey,
          'base-url': req.header.baseURL,
        },
        json: {
          messages: req.messages,
          model: req.model,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          reasoningEffort: req.reasoningEffort,
        },
      },
      { init: { signal: req.abortController.signal } }
    )

    if (!res.ok) {
      const error = (await res.json()) as { error?: string }
      return makeErrorResponse(error?.error || JSON.stringify(error))
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('Failed to get reader from response body.')

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
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
          console.log('Stream completed.')
          running = false
          break
        }

        try {
          const event = parseChatStreamEvent(jsonStr)
          accumulated = updateChatStream(accumulated, event)

          if (event.event === 'delta') {
            id = event.id
            created = event.created
            model = event.model
          }
          if (event.event === 'finish') {
            finishReason = event.finishReason
          }
          if (event.event === 'usage') {
            usage = event.usage
          }

          req.onStream?.(accumulated)
        } catch (error) {
          console.error('JSON parse error:', error)
          running = false
          break
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // キャンセル時は蓄積した内容があれば返す
    } else {
      throw error
    }
  }

  if (!hasAssistantOutput(accumulated)) return null

  return {
    id,
    created,
    model,
    finishReason,
    message: {
      content: accumulated.content,
      reasoningContent: accumulated.reasoningContent,
    },
    usage,
  }
}
