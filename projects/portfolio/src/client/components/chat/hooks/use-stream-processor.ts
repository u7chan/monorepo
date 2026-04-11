import type { AppType } from '#/server/app.d'
import type { ApiChatMessage, ChatCompletionResult, ChatResultSummary, ChatStreamState } from '#/types'
import { hc } from 'hono/client'
import { useCallback, useRef, useState } from 'react'
import {
  parseChatCompletionResponse,
  parseChatCompletionStreamChunk,
  toChatCompletionResult,
  toChatResultSummary,
  updateChatStream,
} from './chat-response'

const client = hc<AppType>('/')

interface SubmitChatCompletionParams {
  header: {
    apiKey: string
    baseURL: string
    mcpServerURLs: string
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
  const [chatResults, setChatResults] = useState<ChatResultSummary | null>(null)

  const cancelStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const resetChatResults = useCallback(() => {
    setChatResults(null)
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
    }: SubmitChatCompletionParams): Promise<{ result: ChatCompletionResult | null; responseTimeMs: number }> => {
      setLoading(true)
      setChatResults(null)
      abortControllerRef.current = new AbortController()
      onSubmitting?.(true)
      const requestStartTime = Date.now()

      try {
        const result = await sendChatCompletion({
          abortController: abortControllerRef.current,
          header,
          model,
          messages,
          stream: streamMode,
          temperature,
          maxTokens,
          reasoningEffort,
          onStream: (stream) => {
            setStream(stream)
          },
        })
        const responseTimeMs = Date.now() - requestStartTime

        if (result) {
          setChatResults(
            toChatResultSummary({
              model: result.model,
              finishReason: result.finishReason,
              responseTimeMs,
              usage: result.usage
                ? {
                    prompt_tokens: result.usage.promptTokens,
                    completion_tokens: result.usage.completionTokens,
                    total_tokens: result.usage.totalTokens,
                    reasoning_tokens: result.usage.reasoningTokens,
                  }
                : null,
            })
          )
        }

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
    chatResults,
    cancelStream,
    resetChatResults,
    submitChatCompletion,
  }
}

const sendChatCompletion = async (req: {
  abortController: AbortController
  header: {
    apiKey: string
    baseURL: string
    mcpServerURLs: string
  }
  model: string
  messages: ApiChatMessage[]
  stream: boolean
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  onStream?: (stream: ChatStreamState) => void
}): Promise<ChatCompletionResult | null> => {
  let result: ChatStreamState = {
    content: '',
    reasoning_content: '',
  }
  let finish_reason = ''
  let usage: ChatResultSummary['usage'] = null
  let responseModel = 'N/A'

  try {
    const res = await client.api.chat.$post(
      {
        header: {
          'api-key': req.header.apiKey,
          'base-url': req.header.baseURL,
          'mcp-server-urls': req.header.mcpServerURLs,
        },
        json: {
          messages: req.messages,
          model: req.model,
          stream: req.stream,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          reasoning_effort: req.reasoningEffort,
          stream_options: req.stream
            ? {
                include_usage: true,
              }
            : undefined,
        },
      },
      { init: { signal: req.abortController.signal } }
    )
    if (!res.ok) {
      const error = (await res.json()) as { message?: string }
      result.content = error?.message || JSON.stringify(error)
    } else {
      const nonStream = res.headers.get('Content-Type')?.includes('application/json') ?? false
      if (nonStream) {
        const data = parseChatCompletionResponse(await res.json())
        const completion = toChatCompletionResult(data)

        if (!completion) {
          return null
        }

        return completion
      } else {
        const reader = res.body?.getReader()
        if (!reader) {
          throw new Error('Failed to get reader from response body.')
        }
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
              const parsedChunk = parseChatCompletionStreamChunk(jsonStr)
              const next = updateChatStream(result, parsedChunk)

              result = next.stream
              if (next.finishReason) {
                finish_reason = next.finishReason
              }
              if (next.model) {
                responseModel = next.model
              }
              if (next.usage) {
                usage = next.usage
              }
              req.onStream?.({
                content: result.content,
                reasoning_content: result.reasoning_content ?? '',
              })
            } catch (error) {
              console.error('JSON parse error:', error)
              running = false
              break
            }
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
  }

  if (!result.content) {
    return null
  }

  return {
    model: responseModel,
    finishReason: finish_reason,
    message: {
      content: result.content,
      reasoningContent: result.reasoning_content ?? '',
    },
    responseTimeMs: 0,
    usage,
  }
}
