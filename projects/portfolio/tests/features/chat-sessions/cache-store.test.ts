import type { ChatSessionEvent, ChatSessionMeta } from '#/types/chat-api'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('InMemoryChatSessionStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const createSession = (): ChatSessionMeta => ({
    id: 'session-1',
    status: 'running',
    conversation: {
      id: 'conversation-1',
      title: 'hello',
      messages: [],
    },
    assistantMessageId: 'message-assistant-1',
    apiMode: 'chat_completions',
    model: 'gpt-test',
    email: null,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    completedAt: null,
    error: null,
  })

  const createEvent = (id: string, content: string): ChatSessionEvent => ({
    id,
    sessionId: 'session-1',
    type: 'assistant_delta',
    createdAt: '2026-05-10T00:00:01.000Z',
    data: {
      event: 'delta',
      id: 'chunk-1',
      created: 1700000000,
      model: 'gpt-test',
      content,
    },
  })

  it('append したイベントを replay し、afterEventId 以降だけ読める', async () => {
    const { InMemoryChatSessionStore } = await import('#/server/features/chat-sessions/cache-store')
    const store = new InMemoryChatSessionStore()

    await store.createSession(createSession())
    await store.appendEvent(createEvent('event-1', 'hello'))
    await store.appendEvent(createEvent('event-2', ' world'))

    await expect(store.readEvents('session-1')).resolves.toHaveLength(2)
    await expect(store.readEvents('session-1', 'event-1')).resolves.toEqual([createEvent('event-2', ' world')])
  })

  it('subscriber に live event を配信し、unsubscribe 後は止める', async () => {
    const { InMemoryChatSessionStore } = await import('#/server/features/chat-sessions/cache-store')
    const store = new InMemoryChatSessionStore()
    const onEvent = vi.fn()

    await store.createSession(createSession())
    const unsubscribe = await store.subscribe('session-1', onEvent)
    await store.appendEvent(createEvent('event-1', 'hello'))
    unsubscribe()
    await store.appendEvent(createEvent('event-2', ' world'))

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(createEvent('event-1', 'hello'))
  })

  it('TTL 超過後に session を破棄する', async () => {
    vi.useFakeTimers()
    const { InMemoryChatSessionStore } = await import('#/server/features/chat-sessions/cache-store')
    const store = new InMemoryChatSessionStore()

    await store.createSession(createSession())
    await store.setSessionTtl('session-1', 1)

    await vi.advanceTimersByTimeAsync(1000)

    await expect(store.getSession('session-1')).resolves.toBeNull()
  })
})
