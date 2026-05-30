import { hc } from 'hono/client'
import type { MutableRefObject } from 'react'
import { hasAssistantOutput, makeErrorResponse } from '#/client/features/chat/lib/chat-response-result'
import { saveActiveSession } from '#/client/features/chat/lib/chat-session-storage'
import {
  receiveSessionEvents,
  type ResumeChatCompletionResult,
} from '#/client/features/chat/lib/receive-session-events'
import type { ChatStreamState } from '#/client/shared/lib/chat-stream'
import { parseChatStreamEvent, updateChatStream } from '#/client/shared/lib/chat-stream'
import type { AppType } from '#/server/app.d'
import type { ApiChatMessage, ApiMode, Conversation } from '#/types'
import type { ChatResponse, ChatUsage } from '#/types/chat-api'

const client = hc<AppType>('/')

export interface SendCompletionParams {
  abortController: AbortController
  header: {
    apiKey: string
    baseURL: string
  }
  apiMode: ApiMode
  model: string
  messages: ApiChatMessage[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

export const sendNonStreamCompletion = async (req: SendCompletionParams): Promise<ChatResponse | null> => {
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
          apiMode: req.apiMode,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          reasoningEffort: req.reasoningEffort,
        },
      } as never,
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

export const sendStreamCompletion = async (
  req: SendCompletionParams & {
    conversation?: Conversation
    assistantMessageId?: string
    eventSourceRef: MutableRefObject<EventSource | null>
    activeSessionIdRef: MutableRefObject<string | null>
    onSessionConversation?: (conversation: Conversation, assistantMessageId: string) => void
    onSessionResult?: (result: Omit<ResumeChatCompletionResult, 'responseTimeMs'>) => void
    onStream?: (stream: ChatStreamState) => void
  }
): Promise<ChatResponse | null> => {
  if (!req.conversation || !req.assistantMessageId) {
    return sendLegacyStreamCompletion(req)
  }

  try {
    const res = await client.api.chat.sessions.$post(
      {
        header: buildChatHeaders(req.header),
        json: {
          conversation: req.conversation,
          assistantMessageId: req.assistantMessageId,
          messages: req.messages,
          model: req.model,
          apiMode: req.apiMode,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          reasoningEffort: req.reasoningEffort,
        },
      } as never,
      { init: { signal: req.abortController.signal } }
    )

    if (!res.ok) {
      const error = (await res.json()) as { error?: string }
      return makeErrorResponse(error?.error || JSON.stringify(error))
    }

    const data = (await res.json()) as { sessionId: string }
    saveActiveSession({ sessionId: data.sessionId })
    req.activeSessionIdRef.current = data.sessionId

    const result = await receiveSessionEvents({
      sessionId: data.sessionId,
      abortSignal: req.abortController.signal,
      eventSourceRef: req.eventSourceRef,
      activeSessionIdRef: req.activeSessionIdRef,
      onSessionConversation: req.onSessionConversation,
      onSessionResult: req.onSessionResult,
      onStream: req.onStream,
    })

    return result.result
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return null
    } else {
      throw error
    }
  }
}

export async function cancelChatSession(sessionId: string): Promise<void> {
  try {
    await client.api.chat.sessions[':sessionId'].cancel.$post({
      param: { sessionId },
    } as never)
  } catch {
    // キャンセル時のネットワーク失敗は既存の AbortController 側でローカル停止する。
  }
}

const sendLegacyStreamCompletion = async (
  req: SendCompletionParams & { onStream?: (stream: ChatStreamState) => void }
): Promise<ChatResponse | null> => {
  let accumulated: ChatStreamState = { content: '', reasoningContent: '' }
  let id = ''
  let created = 0
  let model = 'N/A'
  let finishReason = ''
  let receivedFinish = false
  let usage: ChatUsage | null = null

  const res = await client.api.chat.stream.$post(
    {
      header: buildChatHeaders(req.header),
      json: {
        messages: req.messages,
        model: req.model,
        apiMode: req.apiMode,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        reasoningEffort: req.reasoningEffort,
      },
    } as never,
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
        running = false
        break
      }

      const event = parseChatStreamEvent(jsonStr)
      accumulated = updateChatStream(accumulated, event)

      if (event.event === 'delta') {
        id = event.id
        created = event.created
        model = event.model
      }
      if (event.event === 'finish') {
        finishReason = event.finishReason
        receivedFinish = true
      }
      if (event.event === 'usage') {
        usage = event.usage
      }

      req.onStream?.(accumulated)
    }
  }

  if (!receivedFinish) return null
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

const buildChatHeaders = ({ apiKey, baseURL }: SendCompletionParams['header']) => ({
  'api-key': apiKey,
  'base-url': baseURL,
})
