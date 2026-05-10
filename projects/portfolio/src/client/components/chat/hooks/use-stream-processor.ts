import type { AppType } from '#/server/app.d'
import type { ApiChatMessage, ApiMode, Conversation } from '#/types'
import { ChatSessionEventSchema, type ChatResponse, type ChatSessionEvent, type ChatUsage } from '#/types/chat-api'
import { hc } from 'hono/client'
import { type MutableRefObject, useCallback, useRef, useState } from 'react'
import { type ChatStreamState, parseChatStreamEvent, updateChatStream } from './chat-response'

const client = hc<AppType>('/')
const ACTIVE_SESSION_STORAGE_KEY = 'portfolio.chat.activeSession'

interface SubmitChatCompletionParams {
  header: {
    apiKey: string
    baseURL: string
  }
  apiMode: ApiMode
  model: string
  /** /api/chat wire 形式のメッセージ（toApiChatMessage で変換済み） */
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
}

export function useStreamProcessor({ onSubmitting }: UseStreamProcessorParams = {}) {
  const abortControllerRef = useRef<AbortController | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [stream, setStream] = useState<ChatStreamState | null>(null)

  const cancelStream = useCallback(() => {
    if (activeSessionIdRef.current) {
      void fetch(`/api/chat/sessions/${activeSessionIdRef.current}/cancel`, { method: 'POST' })
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
    [onSubmitting]
  )

  const resumeActiveChatCompletion = useCallback(async (): Promise<ResumeChatCompletionResult | null> => {
    const activeSession = readActiveSession()
    if (!activeSession) return null

    setLoading(true)
    onSubmitting?.(true)
    activeSessionIdRef.current = activeSession.sessionId
    const requestStartTime = Date.now()

    try {
      const result = await receiveSessionEvents({
        sessionId: activeSession.sessionId,
        afterEventId: undefined,
        eventSourceRef,
        activeSessionIdRef,
        onStream: (stream) => setStream(stream),
      })
      if (!result.conversation) return null

      return {
        ...result,
        responseTimeMs: Date.now() - requestStartTime,
      }
    } finally {
      activeSessionIdRef.current = null
      eventSourceRef.current = null
      setStream(null)
      setLoading(false)
      onSubmitting?.(false)
    }
  }, [onSubmitting])

  return {
    loading,
    stream,
    cancelStream,
    submitChatCompletion,
    resumeActiveChatCompletion,
  }
}

interface SendCompletionParams {
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

const sendStreamCompletion = async (
  req: SendCompletionParams & {
    conversation?: Conversation
    assistantMessageId?: string
    eventSourceRef: MutableRefObject<EventSource | null>
    activeSessionIdRef: MutableRefObject<string | null>
    onStream?: (stream: ChatStreamState) => void
  }
): Promise<ChatResponse | null> => {
  if (!req.conversation || !req.assistantMessageId) {
    return sendLegacyStreamCompletion(req)
  }

  try {
    const res = await fetch('/api/chat/sessions', {
      method: 'POST',
      signal: req.abortController.signal,
      headers: {
        'content-type': 'application/json',
        'api-key': req.header.apiKey,
        'base-url': req.header.baseURL,
      },
      body: JSON.stringify({
        conversation: req.conversation,
        assistantMessageId: req.assistantMessageId,
        messages: req.messages,
        model: req.model,
        apiMode: req.apiMode,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        reasoningEffort: req.reasoningEffort,
      }),
    })

    if (!res.ok) {
      const error = (await res.json()) as { error?: string }
      return makeErrorResponse(error?.error || JSON.stringify(error))
    }

    const data = (await res.json()) as { sessionId: string }
    saveActiveSession({ sessionId: data.sessionId })
    req.activeSessionIdRef.current = data.sessionId

    const result = await receiveSessionEvents({
      sessionId: data.sessionId,
      eventSourceRef: req.eventSourceRef,
      activeSessionIdRef: req.activeSessionIdRef,
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

type ActiveSession = {
  sessionId: string
  lastEventId?: string
}

type ResumeChatCompletionResult = {
  conversation: Conversation
  assistantMessageId: string
  result: ChatResponse | null
  responseTimeMs: number
}

type ReceiveSessionEventsParams = {
  sessionId: string
  afterEventId?: string
  eventSourceRef: MutableRefObject<EventSource | null>
  activeSessionIdRef: MutableRefObject<string | null>
  onStream?: (stream: ChatStreamState) => void
}

const receiveSessionEvents = ({
  sessionId,
  afterEventId,
  eventSourceRef,
  activeSessionIdRef,
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

    const url = new URL(`/api/chat/sessions/${sessionId}/events`, window.location.origin)
    if (afterEventId) url.searchParams.set('afterEventId', afterEventId)

    const eventSource = new EventSource(url.toString())
    eventSourceRef.current = eventSource

    const finish = (result: ChatResponse | null) => {
      eventSource.close()
      eventSourceRef.current = null
      activeSessionIdRef.current = null
      clearActiveSession()
      resolve({
        conversation: conversation as Conversation,
        assistantMessageId,
        result,
      })
    }

    const handleSessionEvent = (sessionEvent: ChatSessionEvent) => {
      saveActiveSession({ sessionId, lastEventId: sessionEvent.id })

      if (sessionEvent.type === 'user_message') {
        conversation = sessionEvent.data.conversation
        assistantMessageId = sessionEvent.data.assistantMessageId
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

        finish({
          id,
          created,
          model,
          finishReason,
          message: accumulated,
          usage,
        })
      }
    }

    eventSource.addEventListener('message', (message) => {
      try {
        handleSessionEvent(ChatSessionEventSchema.parse(JSON.parse(message.data)))
      } catch (error) {
        reject(error)
        eventSource.close()
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
          reject(error)
          eventSource.close()
        }
      })
    }

    eventSource.onerror = () => {
      reject(new Error('Session event stream failed.'))
      eventSource.close()
    }
  })

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

function saveActiveSession(session: ActiveSession): void {
  sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(session))
}

function readActiveSession(): ActiveSession | null {
  const value = sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
  if (!value) return null

  try {
    return JSON.parse(value) as ActiveSession
  } catch {
    clearActiveSession()
    return null
  }
}

function clearActiveSession(): void {
  sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
}
