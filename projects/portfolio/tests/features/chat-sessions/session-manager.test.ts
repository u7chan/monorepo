import type { ChatSessionStartRequest } from '#/types/chat-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('ChatSessionManager', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const request: ChatSessionStartRequest = {
    conversation: {
      id: 'conversation-1',
      title: 'hello',
      messages: [
        {
          id: 'message-user-1',
          role: 'user',
          content: 'hello',
          metadata: {
            model: 'gpt-test',
          },
        },
      ],
    },
    assistantMessageId: 'message-assistant-1',
    messages: [{ role: 'user', content: 'hello' }],
    model: 'gpt-test',
    apiMode: 'chat_completions',
  }

  const importSubject = async () => {
    const completionsMock = vi.fn()
    const upsertMock = vi.fn()

    vi.doMock('#/server/features/chat/chat', () => ({
      chat: {
        completions: completionsMock,
      },
    }))
    vi.doMock('#/server/features/chat-conversations/repository', () => ({
      chatConversationRepository: {
        upsert: upsertMock,
      },
    }))

    const [{ InMemoryChatSessionStore }, { ChatSessionManager, foldSessionEvents, isTerminalSessionEvent }] =
      await Promise.all([
        import('#/server/features/chat-sessions/cache-store'),
        import('#/server/features/chat-sessions/session-manager'),
      ])

    const store = new InMemoryChatSessionStore()
    const manager = new ChatSessionManager(store)

    return {
      store,
      manager,
      completionsMock,
      upsertMock,
      foldSessionEvents,
      isTerminalSessionEvent,
    }
  }

  const createStreamChunk = async function* () {
    yield {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: {
            content: 'hello',
          },
          finish_reason: null,
        },
      ],
      usage: null,
    }
    yield {
      id: 'chunk-2',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      },
    }
  }

  it('stream 完了時に event log を作り、ログイン済みなら保存する', async () => {
    const { manager, completionsMock, upsertMock } = await importSubject()
    completionsMock.mockResolvedValue({
      controller: { abort: vi.fn() },
      [Symbol.asyncIterator]: createStreamChunk,
    })

    const session = await manager.startSession({
      header: {
        'api-key': 'api-key',
        'base-url': 'https://example.com',
      },
      req: request,
      apiMode: 'chat_completions',
      email: 'test@example.com',
      databaseUrl: 'postgres://example',
      ttlSeconds: 1800,
      disconnectGraceMs: 30000,
    })

    await vi.waitFor(async () => {
      await expect(manager.getSession(session.id)).resolves.toMatchObject({ status: 'completed' })
    })

    const events = await manager.readEvents(session.id)
    expect(events.map((event) => event.type)).toEqual([
      'user_message',
      'assistant_delta',
      'assistant_finish',
      'usage',
      'done',
    ])
    expect(upsertMock).toHaveBeenCalledWith(
      'postgres://example',
      'test@example.com',
      expect.objectContaining({
        id: 'conversation-1',
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: 'message-assistant-1',
            role: 'assistant',
            content: 'hello',
          }),
        ]),
      })
    )
  })

  it('cancel で cancelled event を追加し、terminal event を判定できる', async () => {
    const { store, manager, isTerminalSessionEvent } = await importSubject()
    await store.createSession({
      id: 'session-1',
      status: 'running',
      conversation: request.conversation,
      assistantMessageId: 'message-assistant-1',
      apiMode: 'chat_completions',
      model: 'gpt-test',
      email: null,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
      completedAt: null,
      error: null,
    })

    await manager.cancelSession('session-1', 'user_requested')
    const events = await manager.readEvents('session-1')

    expect(events.at(-1)).toMatchObject({
      type: 'cancelled',
      data: {
        reason: 'user_requested',
      },
    })
    expect(isTerminalSessionEvent(events.at(-1)!)).toBe(true)
  })

  it('event log を assistant message へ fold する', async () => {
    const { foldSessionEvents } = await importSubject()

    const conversation = foldSessionEvents(
      {
        id: 'session-1',
        status: 'completed',
        conversation: request.conversation,
        assistantMessageId: 'message-assistant-1',
        apiMode: 'chat_completions',
        model: 'gpt-test',
        email: 'test@example.com',
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
        completedAt: '2026-05-10T00:00:01.000Z',
        error: null,
      },
      [
        {
          id: 'event-1',
          sessionId: 'session-1',
          type: 'assistant_delta',
          createdAt: '2026-05-10T00:00:00.000Z',
          data: {
            event: 'delta',
            id: 'chunk-1',
            created: 1700000000,
            model: 'gpt-test',
            content: 'hello',
            reasoningContent: 'thinking',
          },
        },
        {
          id: 'event-2',
          sessionId: 'session-1',
          type: 'assistant_finish',
          createdAt: '2026-05-10T00:00:01.000Z',
          data: {
            event: 'finish',
            id: 'chunk-1',
            created: 1700000000,
            model: 'gpt-test',
            finishReason: 'stop',
          },
        },
      ]
    )

    expect(conversation.messages.at(-1)).toMatchObject({
      id: 'message-assistant-1',
      role: 'assistant',
      content: 'hello',
      reasoningContent: 'thinking',
      metadata: {
        model: 'gpt-test',
        finishReason: 'stop',
      },
    })
  })
})
