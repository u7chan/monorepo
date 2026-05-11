import type { AppType } from '#/server/app.d'
import type { ApiChatMessage, ApiMode, Conversation } from '#/types'
import { ChatSessionEventSchema, type ChatResponse, type ChatSessionEvent, type ChatUsage } from '#/types/chat-api'
import { hc } from 'hono/client'
import { type MutableRefObject, useCallback, useRef, useState } from 'react'
import { type ChatStreamState, parseChatStreamEvent, updateChatStream } from './chat-response'

const client = hc<AppType>('/')
export const ACTIVE_SESSION_STORAGE_KEY = 'portfolio.chat.activeSession'

export function hasActiveChatSession(): boolean {
  return readActiveSession() !== null
}

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
  onSessionConversation?: (conversation: Conversation, assistantMessageId: string) => void
}

export function useStreamProcessor({ onSubmitting, onSessionConversation }: UseStreamProcessorParams = {}) {
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
    [onSessionConversation, onSubmitting]
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
  }, [onSessionConversation, onSubmitting])

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
    onSessionConversation?: (conversation: Conversation, assistantMessageId: string) => void
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

const buildChatHeaders = ({ apiKey, baseURL }: SendCompletionParams['header']) => ({
  'api-key': apiKey,
  'base-url': baseURL,
})

async function cancelChatSession(sessionId: string): Promise<void> {
  try {
    await client.api.chat.sessions[':sessionId'].cancel.$post({
      param: { sessionId },
    } as never)
  } catch {
    // キャンセル時のネットワーク失敗は既存の AbortController 側でローカル停止する。
  }
}

function buildChatSessionEventsUrl(sessionId: string, afterEventId?: string): string {
  const url = new URL(`/api/chat/sessions/${encodeURIComponent(sessionId)}/events`, window.location.origin)
  if (afterEventId) url.searchParams.set('afterEventId', afterEventId)
  return url.toString()
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
  abortSignal?: AbortSignal
  eventSourceRef: MutableRefObject<EventSource | null>
  activeSessionIdRef: MutableRefObject<string | null>
  onSessionConversation?: (conversation: Conversation, assistantMessageId: string) => void
  onStream?: (stream: ChatStreamState) => void
}

const receiveSessionEvents = ({
  sessionId,
  afterEventId,
  abortSignal,
  eventSourceRef,
  activeSessionIdRef,
  onSessionConversation,
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
      clearActiveSession()
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

function saveActiveSession(session: ActiveSession): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(session))
}

function readActiveSession(): ActiveSession | null {
  if (typeof sessionStorage === 'undefined') return null

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
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
}
