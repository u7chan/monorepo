// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'portfolio.chat-settings'

const defaultSettings = {
  schemaVersion: '1.2.0',
  model: 'gpt-4.1-mini',
  baseURL: '',
  apiKey: '',
  apiMode: 'chat_completions',
  temperature: 0.7,
  temperatureEnabled: false,
  maxTokens: undefined,
  reasoningEffort: 'medium',
  reasoningEffortEnabled: false,
  fakeMode: false,
  autoModel: false,
  markdownPreview: true,
  streamMode: true,
  interactiveMode: true,
  templateModels: {},
}

const createLocalStorageMock = (initialEntries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initialEntries))

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

const navigateMock = vi.fn()
const useSearchMock = vi.fn()
const useQueryMock = vi.fn()
const useMetaPropsMock = vi.fn()
const conversationsGetMock = vi.fn()
const conversationsPostMock = vi.fn()
const conversationsDeleteMock = vi.fn()
const messagesDeleteMock = vi.fn()

let chatMainProps: Record<string, unknown> | null = null
let conversationHistoryProps: Record<string, unknown> | null = null

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

vi.mock('#/client/routes/chat', () => ({
  Route: {
    useSearch: () => useSearchMock(),
    useNavigate: () => navigateMock,
  },
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}))

vi.mock('#/client/pages/home', () => ({
  useMetaProps: () => useMetaPropsMock(),
}))

vi.mock('hono/client', () => ({
  hc: () => ({
    api: {
      conversations: {
        $get: (...args: unknown[]) => conversationsGetMock(...args),
        $post: (...args: unknown[]) => conversationsPostMock(...args),
        $delete: (...args: unknown[]) => conversationsDeleteMock(...args),
        messages: {
          $delete: (...args: unknown[]) => messagesDeleteMock(...args),
        },
      },
    },
  }),
}))

vi.mock('#/client/components/chat/chat-layout', () => ({
  ChatLayout: ({ children, conversations }: { children: ReactNode; conversations?: ReactNode }) => (
    <div>
      {conversations}
      {children}
    </div>
  ),
}))

vi.mock('#/client/components/chat/chat-settings', () => ({
  ChatSettings: () => null,
}))

vi.mock('#/client/components/chat/chat-main', () => ({
  ChatMain: (props: Record<string, unknown>) => {
    chatMainProps = props
    return null
  },
}))

vi.mock('#/client/components/chat/conversation-history', () => ({
  ConversationHistory: (props: Record<string, unknown>) => {
    conversationHistoryProps = props
    return null
  },
}))

const conversations = [
  {
    id: 'conversation-1',
    title: '会話1',
    updatedAt: new Date('2026-04-21T00:00:00.000Z'),
    messages: [
      {
        id: 'message-1',
        role: 'user' as const,
        content: 'hello',
        reasoningContent: '',
        metadata: { model: 'gpt-test' },
      },
    ],
  },
]

describe('Chat page', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'localStorage',
      createLocalStorageMock({
        [STORAGE_KEY]: JSON.stringify(defaultSettings),
      })
    )
    vi.resetModules()
    vi.clearAllMocks()
    chatMainProps = null
    conversationHistoryProps = null
    useMetaPropsMock.mockReturnValue({ email: 'test@example.com' })
    useSearchMock.mockReturnValue({})
    useQueryMock.mockReturnValue({
      data: conversations,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    })
    conversationsGetMock.mockResolvedValue({
      json: async () => ({ data: conversations }),
    })
    conversationsPostMock.mockResolvedValue({ status: 200 })
    conversationsDeleteMock.mockResolvedValue({ status: 200 })
    messagesDeleteMock.mockResolvedValue({ status: 200 })
  })

  it('URL の conversationId に対応する会話を ChatMain に渡す', async () => {
    useSearchMock.mockReturnValue({ conversationId: 'conversation-1' })

    const { Chat } = await import('#/client/pages/chat')
    render(<Chat />)

    expect(chatMainProps?.currentConversation).toEqual(conversations[0])
  })

  it('無効な conversationId は /chat に replace で正規化する', async () => {
    useSearchMock.mockReturnValue({ conversationId: 'missing-conversation' })

    const { Chat } = await import('#/client/pages/chat')
    render(<Chat />)

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/chat',
        search: { conversationId: undefined },
        replace: true,
      })
    })
  })

  it('新規会話の初回保存成功時は conversationId 付き URL へ replace する', async () => {
    const refetchMock = vi.fn().mockResolvedValue({ data: conversations })
    useQueryMock.mockReturnValue({
      data: conversations,
      isLoading: false,
      isFetching: false,
      refetch: refetchMock,
    })

    const { Chat } = await import('#/client/pages/chat')
    render(<Chat />)

    const onConversationChange = chatMainProps?.onConversationChange as
      | ((conversation: (typeof conversations)[number]) => Promise<void>)
      | undefined

    expect(onConversationChange).toBeTypeOf('function')

    await onConversationChange?.(conversations[0])

    expect(refetchMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/chat',
      search: { conversationId: 'conversation-1' },
      replace: true,
    })
  })

  it('初回保存では refetch 完了まで conversationId 付き URL へ遷移しない', async () => {
    const deferred = createDeferred<{ data: typeof conversations }>()
    const refetchMock = vi.fn().mockReturnValue(deferred.promise)
    useQueryMock.mockReturnValue({
      data: conversations,
      isLoading: false,
      isFetching: false,
      refetch: refetchMock,
    })

    const { Chat } = await import('#/client/pages/chat')
    render(<Chat />)

    const onConversationChange = chatMainProps?.onConversationChange as
      | ((conversation: (typeof conversations)[number]) => Promise<void>)
      | undefined

    expect(onConversationChange).toBeTypeOf('function')

    const savePromise = onConversationChange?.(conversations[0])

    expect(navigateMock).not.toHaveBeenCalled()

    deferred.resolve({ data: conversations })
    await savePromise

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/chat',
      search: { conversationId: 'conversation-1' },
      replace: true,
    })
  })

  it('会話履歴選択時は conversationId 付き URL へ遷移する', async () => {
    const { Chat } = await import('#/client/pages/chat')
    render(<Chat />)

    const onSelectConversation = conversationHistoryProps?.onSelectConversation as
      | ((conversationId: string) => void)
      | undefined

    expect(onSelectConversation).toBeTypeOf('function')

    onSelectConversation?.('conversation-1')

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/chat',
      search: { conversationId: 'conversation-1' },
      replace: false,
    })
  })

  it('conversationId 解決中は ChatMain の代わりに loading を表示する', async () => {
    useSearchMock.mockReturnValue({ conversationId: 'conversation-1' })
    useQueryMock.mockReturnValue({
      data: [],
      isLoading: true,
      isFetching: true,
      refetch: vi.fn(),
    })

    const { Chat } = await import('#/client/pages/chat')
    const view = render(<Chat />)

    expect(chatMainProps).toBeNull()
    expect(view.getAllByText('会話を読み込み中...').length).toBeGreaterThan(0)
  })
})
