import type { ChatSessionEvent, ChatSessionMeta } from '#/types/chat-api'

export interface CacheStore {
  createSession(session: ChatSessionMeta): Promise<void>
  getSession(sessionId: string): Promise<ChatSessionMeta | null>
  updateSession(sessionId: string, patch: Partial<ChatSessionMeta>): Promise<void>
  appendEvent(event: ChatSessionEvent): Promise<void>
  readEvents(sessionId: string, afterEventId?: string): Promise<ChatSessionEvent[]>
  subscribe(sessionId: string, onEvent: (event: ChatSessionEvent) => void): Promise<() => void>
  setSessionTtl(sessionId: string, seconds: number): Promise<void>
}

type SessionRecord = {
  meta: ChatSessionMeta
  events: ChatSessionEvent[]
  ttlTimer: ReturnType<typeof setTimeout> | null
  subscribers: Set<(event: ChatSessionEvent) => void>
}

export class InMemoryChatSessionStore implements CacheStore {
  private readonly sessions = new Map<string, SessionRecord>()

  async createSession(session: ChatSessionMeta): Promise<void> {
    this.sessions.set(session.id, {
      meta: session,
      events: [],
      ttlTimer: null,
      subscribers: new Set(),
    })
  }

  async getSession(sessionId: string): Promise<ChatSessionMeta | null> {
    return this.sessions.get(sessionId)?.meta ?? null
  }

  async updateSession(sessionId: string, patch: Partial<ChatSessionMeta>): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) return

    record.meta = {
      ...record.meta,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }
  }

  async appendEvent(event: ChatSessionEvent): Promise<void> {
    const record = this.sessions.get(event.sessionId)
    if (!record) return

    record.events.push(event)
    for (const subscriber of record.subscribers) {
      subscriber(event)
    }
  }

  async readEvents(sessionId: string, afterEventId?: string): Promise<ChatSessionEvent[]> {
    const events = this.sessions.get(sessionId)?.events ?? []
    if (!afterEventId) return [...events]

    const index = events.findIndex((event) => event.id === afterEventId)
    if (index === -1) return [...events]

    return events.slice(index + 1)
  }

  async subscribe(sessionId: string, onEvent: (event: ChatSessionEvent) => void): Promise<() => void> {
    const record = this.sessions.get(sessionId)
    if (!record) return () => {}

    record.subscribers.add(onEvent)
    return () => {
      record.subscribers.delete(onEvent)
    }
  }

  async setSessionTtl(sessionId: string, seconds: number): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) return

    if (record.ttlTimer) clearTimeout(record.ttlTimer)
    record.ttlTimer = setTimeout(() => {
      this.sessions.delete(sessionId)
    }, seconds * 1000)
  }
}

export const chatSessionStore = new InMemoryChatSessionStore()
