import { uuidv7 } from 'uuidv7'
import { chatConversationRepository } from '#/server/features/chat-conversations/repository'
import { chat } from '#/server/features/chat/chat'
import { convertStreamChunks } from '#/server/features/chat/converter'
import type { ResponsesStreamChunk, StreamChunk } from '#/server/features/chat/transport'
import { logger } from '#/server/lib/logger'
import type { ApiMode, AssistantMessage, Conversation } from '#/types'
import type {
  ChatSessionEvent,
  ChatSessionMeta,
  ChatSessionStartRequest,
  ChatSessionStatus,
  ChatStreamEvent,
  ChatUsage,
} from '#/types/chat-api'
import type { CacheStore } from './cache-store'
import { chatSessionStore } from './cache-store'

type StartSessionParams = {
  header: {
    'api-key': string
    'base-url': string
  }
  req: ChatSessionStartRequest
  apiMode: ApiMode
  email: string | null
  databaseUrl?: string
  ttlSeconds: number
  disconnectGraceMs: number
}

type SessionRuntime = {
  controller: AbortController | null
  subscribers: number
  graceTimer: ReturnType<typeof setTimeout> | null
}

const TERMINAL_EVENT_TYPES = new Set<ChatSessionEvent['type']>(['done', 'cancelled', 'error'])

export class ChatSessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>()

  constructor(private readonly store: CacheStore) {}

  async startSession(params: StartSessionParams): Promise<ChatSessionMeta> {
    const now = new Date().toISOString()
    const session: ChatSessionMeta = {
      id: uuidv7(),
      status: 'running',
      conversation: params.req.conversation,
      assistantMessageId: params.req.assistantMessageId,
      apiMode: params.apiMode,
      model: params.req.model,
      email: params.email,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
    }

    await this.store.createSession(session)
    await this.appendEvent(session.id, {
      type: 'user_message',
      data: {
        conversation: params.req.conversation,
        assistantMessageId: params.req.assistantMessageId,
      },
    })
    this.runtimes.set(session.id, {
      controller: null,
      subscribers: 0,
      graceTimer: null,
    })

    void this.runGeneration(session.id, params)

    return session
  }

  async getSession(sessionId: string): Promise<ChatSessionMeta | null> {
    return this.store.getSession(sessionId)
  }

  async readEvents(sessionId: string, afterEventId?: string): Promise<ChatSessionEvent[]> {
    return this.store.readEvents(sessionId, afterEventId)
  }

  async subscribe(sessionId: string, onEvent: (event: ChatSessionEvent) => void): Promise<() => void> {
    const runtime = this.ensureRuntime(sessionId)
    runtime.subscribers += 1
    if (runtime.graceTimer) {
      clearTimeout(runtime.graceTimer)
      runtime.graceTimer = null
    }

    const unsubscribe = await this.store.subscribe(sessionId, onEvent)

    return () => {
      unsubscribe()
      runtime.subscribers = Math.max(0, runtime.subscribers - 1)
    }
  }

  scheduleDisconnectGrace(sessionId: string, disconnectGraceMs: number): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime || runtime.subscribers > 0 || runtime.graceTimer) return

    runtime.graceTimer = setTimeout(() => {
      runtime.graceTimer = null
      if (runtime.subscribers === 0) {
        void this.cancelSession(sessionId, 'disconnect_grace_expired')
      }
    }, disconnectGraceMs)
  }

  async cancelSession(sessionId: string, reason = 'cancelled'): Promise<ChatSessionMeta | null> {
    const session = await this.store.getSession(sessionId)
    if (!session || session.status !== 'running') return session

    const runtime = this.runtimes.get(sessionId)
    runtime?.controller?.abort()
    await this.finishSession(sessionId, 'cancelled', { reason })

    return this.store.getSession(sessionId)
  }

  private async runGeneration(sessionId: string, params: StartSessionParams): Promise<void> {
    const runtime = this.ensureRuntime(sessionId)
    const controller = new AbortController()
    runtime.controller = controller

    try {
      const completion = await chat.completions(
        {
          apiKey: params.header['api-key'],
          baseURL: params.header['base-url'],
        },
        {
          apiMode: params.apiMode,
          model: params.req.model,
          messages: params.req.messages,
          temperature: params.req.temperature,
          maxTokens: params.req.maxTokens,
          reasoningEffort: params.req.reasoningEffort,
          stream: true,
          includeUsage: true,
        }
      )

      const streamCompletion = completion as StreamChunk | ResponsesStreamChunk
      runtime.controller = streamCompletion.controller

      for await (const event of convertStreamChunks(params.apiMode, streamCompletion)) {
        if ((await this.store.getSession(sessionId))?.status !== 'running') return

        await this.appendStreamEvent(sessionId, event)
      }

      if ((await this.store.getSession(sessionId))?.status === 'running') {
        await this.finishSession(sessionId, 'completed')
        await this.persistIfSignedIn(sessionId, params.databaseUrl, params.ttlSeconds)
      }
    } catch (err) {
      if (controller.signal.aborted || runtime.controller?.signal.aborted) return

      logger.error({ err, sessionId }, 'Session chat generation failed')
      await this.finishSession(sessionId, 'error', {
        message: err instanceof Error ? err.message : 'Upstream error',
      })
      await this.persistIfSignedIn(sessionId, params.databaseUrl, params.ttlSeconds)
    } finally {
      runtime.controller = null
      await this.store.setSessionTtl(sessionId, params.ttlSeconds)
    }
  }

  private async appendStreamEvent(sessionId: string, event: ChatStreamEvent): Promise<void> {
    if (event.event === 'delta') {
      await this.appendEvent(sessionId, {
        type: 'assistant_delta',
        data: event,
      })
      return
    }

    if (event.event === 'finish') {
      await this.appendEvent(sessionId, {
        type: 'assistant_finish',
        data: event,
      })
      return
    }

    await this.appendEvent(sessionId, {
      type: 'usage',
      data: event,
    })
  }

  private async finishSession(
    sessionId: string,
    status: Exclude<ChatSessionStatus, 'running'>,
    data: { reason?: string; message?: string } = {}
  ): Promise<void> {
    await this.store.updateSession(sessionId, {
      status,
      completedAt: new Date().toISOString(),
      error: data.message ?? null,
    })

    if (status === 'completed') {
      await this.appendEvent(sessionId, { type: 'done', data: {} })
      return
    }

    if (status === 'cancelled') {
      await this.appendEvent(sessionId, {
        type: 'cancelled',
        data: {
          reason: data.reason ?? 'cancelled',
        },
      })
      return
    }

    await this.appendEvent(sessionId, {
      type: 'error',
      data: {
        message: data.message ?? 'Upstream error',
      },
    })
  }

  private async appendEvent(sessionId: string, event: Omit<ChatSessionEvent, 'id' | 'sessionId' | 'createdAt'>) {
    await this.store.appendEvent({
      ...event,
      id: uuidv7(),
      sessionId,
      createdAt: new Date().toISOString(),
    } as ChatSessionEvent)
  }

  private async persistIfSignedIn(
    sessionId: string,
    databaseUrl: string | undefined,
    ttlSeconds: number
  ): Promise<void> {
    const session = await this.store.getSession(sessionId)
    if (!session || !session.email || !databaseUrl) return

    const events = await this.store.readEvents(sessionId)
    const conversation = foldSessionEvents(session, events)
    await chatConversationRepository.upsert(databaseUrl, session.email, conversation)
    await this.store.setSessionTtl(sessionId, ttlSeconds)
  }

  private ensureRuntime(sessionId: string): SessionRuntime {
    const existing = this.runtimes.get(sessionId)
    if (existing) return existing

    const runtime = {
      controller: null,
      subscribers: 0,
      graceTimer: null,
    }
    this.runtimes.set(sessionId, runtime)
    return runtime
  }
}

export function foldSessionEvents(session: ChatSessionMeta, events: ChatSessionEvent[]): Conversation {
  let content = ''
  let reasoningContent = ''
  let finishReason = ''
  let usage: ChatUsage | null = null
  let id = ''
  let created = 0
  let model = session.model

  for (const event of events) {
    if (event.type === 'assistant_delta') {
      content += event.data.content ?? ''
      reasoningContent += event.data.reasoningContent ?? ''
      id = event.data.id || id
      created = event.data.created || created
      model = event.data.model || model
    }

    if (event.type === 'assistant_finish') {
      finishReason = event.data.finishReason
      id = event.data.id || id
      created = event.data.created || created
      model = event.data.model || model
    }

    if (event.type === 'usage') {
      usage = event.data.usage
    }
  }

  const assistantMessage: AssistantMessage = {
    id: session.assistantMessageId,
    role: 'assistant',
    content,
    reasoningContent,
    metadata: {
      model,
      apiMode: session.apiMode,
      finishReason,
      responseTimeMs: Date.now() - new Date(session.createdAt).getTime(),
      usage: {
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens,
      },
    },
  }

  return {
    ...session.conversation,
    messages: [...session.conversation.messages, assistantMessage],
  }
}

export function isTerminalSessionEvent(event: ChatSessionEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type)
}

export const chatSessionManager = new ChatSessionManager(chatSessionStore)
