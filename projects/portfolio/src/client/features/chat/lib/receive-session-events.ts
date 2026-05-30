import type { MutableRefObject } from 'react'
import { hasAssistantOutput, makeErrorResponse } from '#/client/features/chat/lib/chat-response-result'
import { saveActiveSession } from '#/client/features/chat/lib/chat-session-storage'
import type { ChatStreamState } from '#/client/shared/lib/chat-stream'
import { updateChatStream } from '#/client/shared/lib/chat-stream'
import type { Conversation } from '#/types'
import { ChatSessionEventSchema, type ChatResponse, type ChatSessionEvent, type ChatUsage } from '#/types/chat-api'

export type ResumeChatCompletionResult = {
  conversation: Conversation
  assistantMessageId: string
  result: ChatResponse | null
  responseTimeMs: number
}

type ReceiveSessionEventsParams = {
  sessionId: string
  afterEventId?: string
  abortSignal?: AbortSignal
  eventSourceRef: MutableRefObject<EventSource | null>
  activeSessionIdRef: MutableRefObject<string | null>
  onSessionConversation?: (conversation: Conversation, assistantMessageId: string) => void
  onSessionResult?: (result: Omit<ResumeChatCompletionResult, 'responseTimeMs'>) => void
  onStream?: (stream: ChatStreamState) => void
}

export const receiveSessionEvents = ({
  sessionId,
  afterEventId,
  abortSignal,
  eventSourceRef,
  activeSessionIdRef,
  onSessionConversation,
  onSessionResult,
  onStream,
}: ReceiveSessionEventsParams): Promise<Omit<ResumeChatCompletionResult, 'responseTimeMs'>> =>
  new Promise((resolve, reject) => {
    let accumulated: ChatStreamState = { content: '', reasoningContent: '' }
    let id = ''
    let created = 0
    let model = 'N/A'
    let finishReason = ''
    let receivedFinish = false
    let usage: ChatUsage | null = null
    let conversation: Conversation | null = null
    let assistantMessageId = ''
    let settled = false

    const eventSource = new EventSource(buildChatSessionEventsUrl(sessionId, afterEventId))
    eventSourceRef.current = eventSource

    const cleanup = () => {
      eventSource.close()
      eventSourceRef.current = null
      abortSignal?.removeEventListener('abort', handleAbort)
    }

    const finish = (result: ChatResponse | null) => {
      if (settled) return
      settled = true
      cleanup()
      activeSessionIdRef.current = null
      resolve({
        conversation: conversation as Conversation,
        assistantMessageId,
        result,
      })
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function handleAbort() {
      finish(null)
    }

    if (abortSignal?.aborted) {
      finish(null)
      return
    }
    abortSignal?.addEventListener('abort', handleAbort, { once: true })

    const handleSessionEvent = (sessionEvent: ChatSessionEvent) => {
      saveActiveSession({ sessionId, lastEventId: sessionEvent.id })

      if (sessionEvent.type === 'user_message') {
        conversation = sessionEvent.data.conversation
        assistantMessageId = sessionEvent.data.assistantMessageId
        onSessionConversation?.(conversation, assistantMessageId)
        return
      }

      if (sessionEvent.type === 'assistant_delta') {
        accumulated = updateChatStream(accumulated, sessionEvent.data)
        id = sessionEvent.data.id
        created = sessionEvent.data.created
        model = sessionEvent.data.model
        onStream?.(accumulated)
        return
      }

      if (sessionEvent.type === 'assistant_finish') {
        finishReason = sessionEvent.data.finishReason
        receivedFinish = true
        return
      }

      if (sessionEvent.type === 'usage') {
        usage = sessionEvent.data.usage
        return
      }

      if (sessionEvent.type === 'cancelled') {
        finish(null)
        return
      }

      if (sessionEvent.type === 'error') {
        finish(makeErrorResponse(sessionEvent.data.message))
        return
      }

      if (sessionEvent.type === 'done') {
        if (!receivedFinish || !hasAssistantOutput(accumulated)) {
          finish(null)
          return
        }

        const result = {
          id,
          created,
          model,
          finishReason,
          message: accumulated,
          usage,
        }
        const sessionResult = {
          conversation: conversation as Conversation,
          assistantMessageId,
          result,
        }
        onSessionResult?.(sessionResult)
        finish(sessionResult.result)
      }
    }

    eventSource.addEventListener('message', (message) => {
      try {
        handleSessionEvent(ChatSessionEventSchema.parse(JSON.parse(message.data)))
      } catch (error) {
        fail(error)
      }
    })

    for (const eventType of [
      'user_message',
      'assistant_delta',
      'assistant_finish',
      'usage',
      'done',
      'cancelled',
      'error',
    ]) {
      eventSource.addEventListener(eventType, (message) => {
        try {
          handleSessionEvent(ChatSessionEventSchema.parse(JSON.parse(message.data)))
        } catch (error) {
          fail(error)
        }
      })
    }

    eventSource.onerror = () => {
      // EventSource は一時切断時も onerror 後に自動再接続するため、terminal event を待つ。
    }
  })

function buildChatSessionEventsUrl(sessionId: string, afterEventId?: string): string {
  const url = new URL(`/api/chat/sessions/${encodeURIComponent(sessionId)}/events`, window.location.origin)
  if (afterEventId) url.searchParams.set('afterEventId', afterEventId)
  return url.toString()
}
