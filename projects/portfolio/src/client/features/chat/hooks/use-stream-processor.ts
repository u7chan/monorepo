import { useCallback, useRef, useState } from 'react'
import {
  cancelChatSession,
  sendNonStreamCompletion,
  sendStreamCompletion,
} from '#/client/features/chat/api/chat-completion-client'
import { clearActiveSession, readActiveSession } from '#/client/features/chat/lib/chat-session-storage'
import {
  receiveSessionEvents,
  type ResumeChatCompletionResult,
} from '#/client/features/chat/lib/receive-session-events'
import type { ChatStreamState } from '#/client/shared/lib/chat-stream'
import type { ApiChatMessage, ApiMode, Conversation } from '#/types'
import type { ChatResponse } from '#/types/chat-api'

export {
  ACTIVE_SESSION_STORAGE_KEY,
  hasActiveChatSession,
  clearActiveSession as clearActiveChatSession,
} from '#/client/features/chat/lib/chat-session-storage'

interface SubmitChatCompletionParams {
  header: {
    apiKey: string
    baseURL: string
  }
  apiMode: ApiMode
  model: string
  messages: ApiChatMessage[]
  streamMode: boolean
  conversation?: Conversation
  assistantMessageId?: string
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

interface UseStreamProcessorParams {
  onSubmitting?: (submitting: boolean) => void
  onSessionConversation?: (conversation: Conversation, assistantMessageId: string) => void
  onSessionResult?: (result: Omit<ResumeChatCompletionResult, 'responseTimeMs'>) => void
}

export function useStreamProcessor({
  onSubmitting,
  onSessionConversation,
  onSessionResult,
}: UseStreamProcessorParams = {}) {
  const abortControllerRef = useRef<AbortController | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [stream, setStream] = useState<ChatStreamState | null>(null)

  const cancelStream = useCallback(() => {
    if (activeSessionIdRef.current) {
      void cancelChatSession(activeSessionIdRef.current)
    }
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    clearActiveSession()
  }, [])

  const submitChatCompletion = useCallback(
    async ({
      header,
      apiMode,
      model,
      messages,
      streamMode,
      conversation,
      assistantMessageId,
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
              eventSourceRef,
              activeSessionIdRef,
              header,
              apiMode,
              model,
              messages,
              conversation,
              assistantMessageId,
              temperature,
              maxTokens,
              reasoningEffort,
              onSessionConversation,
              onSessionResult,
              onStream: (stream) => setStream(stream),
            })
          : await sendNonStreamCompletion({
              abortController: abortControllerRef.current,
              header,
              apiMode,
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
    [onSessionConversation, onSessionResult, onSubmitting]
  )

  const resumeActiveChatCompletion = useCallback(async (): Promise<ResumeChatCompletionResult | null> => {
    const activeSession = readActiveSession()
    if (!activeSession) return null

    setLoading(true)
    abortControllerRef.current = new AbortController()
    onSubmitting?.(true)
    activeSessionIdRef.current = activeSession.sessionId
    const requestStartTime = Date.now()

    try {
      const result = await receiveSessionEvents({
        sessionId: activeSession.sessionId,
        afterEventId: undefined,
        abortSignal: abortControllerRef.current.signal,
        eventSourceRef,
        activeSessionIdRef,
        onSessionConversation,
        onSessionResult,
        onStream: (stream) => setStream(stream),
      })
      if (!result.conversation) return null

      return {
        ...result,
        responseTimeMs: Date.now() - requestStartTime,
      }
    } finally {
      abortControllerRef.current = null
      activeSessionIdRef.current = null
      eventSourceRef.current = null
      setStream(null)
      setLoading(false)
      onSubmitting?.(false)
    }
  }, [onSessionConversation, onSessionResult, onSubmitting])

  return {
    loading,
    stream,
    cancelStream,
    submitChatCompletion,
    resumeActiveChatCompletion,
  }
}
