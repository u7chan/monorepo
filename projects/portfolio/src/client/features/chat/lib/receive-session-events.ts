import type { MutableRefObject } from 'react'
import { hasAssistantOutput } from '#/client/features/chat/lib/chat-response-result'
import { clearActiveSession, saveActiveSession } from '#/client/features/chat/lib/chat-session-storage'
import { unavailableChatError } from '#/client/shared/lib/chat-error'
import type { ChatStreamState } from '#/client/shared/lib/chat-stream'
import { updateChatStream } from '#/client/shared/lib/chat-stream'
import type { Conversation } from '#/types'
import {
  ChatSessionEventSchema,
  ChatSessionMetaSchema,
  type ChatError,
  type ChatResponse,
  type ChatSessionEvent,
  type ChatUsage,
} from '#/types/chat-api'

export type ResumeChatCompletionResult = {
  conversation: Conversation | null
  assistantMessageId: string
  result: ChatResponse | null
  error: ChatError | null
  responseTimeMs: number
}

export type CompletedSessionChatResult = {
  conversation: Conversation
  assistantMessageId: string
  result: ChatResponse
}

const EVENT_SOURCE_ERROR_TIMEOUT_MS = 15_000

type ReceiveSessionEventsParams = {
  sessionId: string
  afterEventId?: string
  abortSignal?: AbortSignal
  eventSourceRef: MutableRefObject<EventSource | null>
  activeSessionIdRef: MutableRefObject<string | null>
  onSessionConversation?: (conversation: Conversation, assistantMessageId: string) => void
  onSessionResult?: (result: CompletedSessionChatResult) => void
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
    let eventSourceErrorTimeout: ReturnType<typeof setTimeout> | null = null

    const eventSource = new EventSource(buildChatSessionEventsUrl(sessionId, afterEventId))
    eventSourceRef.current = eventSource

    const cleanup = () => {
      eventSource.close()
      eventSourceRef.current = null
      abortSignal?.removeEventListener('abort', handleAbort)
      if (eventSourceErrorTimeout) {
        clearTimeout(eventSourceErrorTimeout)
        eventSourceErrorTimeout = null
      }
    }

    const finish = (result: ChatResponse | null, error: ChatError | null = null) => {
      if (settled) return
      settled = true
      cleanup()
      activeSessionIdRef.current = null
      clearActiveSession()
      resolve({
        conversation,
        assistantMessageId,
        result,
        error,
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
      if (eventSourceErrorTimeout) {
        clearTimeout(eventSourceErrorTimeout)
        eventSourceErrorTimeout = null
      }
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

      if (sessionEvent.type === 'generation_error') {
        finish(null, sessionEvent.data)
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
          error: null,
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
      'generation_error',
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
      void checkTerminalSession()
      if (eventSourceErrorTimeout) return

      eventSourceErrorTimeout = setTimeout(() => {
        finish(null, unavailableChatError())
      }, EVENT_SOURCE_ERROR_TIMEOUT_MS)
    }

    async function checkTerminalSession() {
      try {
        const response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`)
        if (!response.ok) return

        const payload = (await response.json()) as { session?: unknown }
        const parsed = ChatSessionMetaSchema.safeParse(payload.session)
        if (!parsed.success) return

        if (parsed.data.status === 'error') {
          finish(null, parsed.data.error ?? unavailableChatError())
        } else if (parsed.data.status === 'cancelled') {
          finish(null)
        }
      } catch {
        // EventSource の自動再接続と timeout で復旧・終了を判断する。
      }
    }
  })

function buildChatSessionEventsUrl(sessionId: string, afterEventId?: string): string {
  const url = new URL(`/api/chat/sessions/${encodeURIComponent(sessionId)}/events`, window.location.origin)
  if (afterEventId) url.searchParams.set('afterEventId', afterEventId)
  return url.toString()
}
