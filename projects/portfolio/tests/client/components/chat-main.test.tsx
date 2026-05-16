// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { AssistantMessage, Conversation, UserMessage } from '#/types'

const useMessageScrollMock = vi.fn()
const scrollToMessageEndMock = vi.fn()
const submitChatCompletionMock = vi.fn()
const resumeActiveChatCompletionMock = vi.fn()
let hasActiveChatSessionMock = false
let streamProcessorParams: Record<string, unknown> | null = null
let chatMessageListProps: Record<string, unknown> | null = null

vi.mock('#/client/components/chat/chat-input', () => ({
  ChatInput: () => <div data-testid='chat-input' />,
}))

vi.mock('#/client/components/chat/chat-message-list', () => ({
  ChatMessageList: (props: Record<string, unknown>) => {
    chatMessageListProps = props
    return <div data-testid='chat-message-list' />
  },
}))

vi.mock('#/client/components/chat/hooks/use-chat-form', () => ({
  useChatForm: () => ({
    input: '',
    uploadImages: [],
    textAreaRows: 2,
    setTemplateInput: vi.fn(),
    handleUploadImageChange: vi.fn(),
    handleChangeInput: vi.fn(),
    handleKeyDown: vi.fn(),
    handleChangeComposition: vi.fn(),
    buildChatMessages: vi.fn(),
    resetAfterSubmit: vi.fn(),
  }),
}))

vi.mock('#/client/components/chat/hooks/use-message-copy', () => ({
  useMessageCopy: () => ({
    copiedId: '',
    copyMessage: vi.fn(),
  }),
}))

vi.mock('#/client/components/chat/hooks/use-message-scroll', () => ({
  useMessageScroll: (...args: unknown[]) => useMessageScrollMock(...args),
}))

vi.mock('#/client/components/chat/hooks/use-stream-processor', () => ({
  hasActiveChatSession: () => hasActiveChatSessionMock,
  useStreamProcessor: (params: Record<string, unknown>) => {
    streamProcessorParams = params
    return {
      loading: false,
      stream: null,
      cancelStream: vi.fn(),
      submitChatCompletion: submitChatCompletionMock,
      resumeActiveChatCompletion: resumeActiveChatCompletionMock,
    }
  },
}))

vi.mock('#/client/components/chat/prompt-template', () => ({
  PromptTemplate: () => <div data-testid='prompt-template' />,
}))

vi.mock('#/client/components/input/file-image-input', () => ({
  FileImageInput: ({ fileInputButton }: { fileInputButton: (onClick: () => void) => React.ReactNode }) => (
    <div>{fileInputButton(vi.fn())}</div>
  ),
  FileImagePreview: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const createUserMessage = (id: string, content: string): UserMessage => ({
  id,
  role: 'user',
  content,
  reasoningContent: '',
  metadata: {
    model: 'gpt-test',
  },
})

const createAssistantMessage = (id: string, content: string): AssistantMessage => ({
  id,
  role: 'assistant',
  content,
  reasoningContent: '',
  metadata: {
    model: 'gpt-test',
    usage: {},
  },
})

const currentConversation: Conversation = {
  id: 'conversation-1',
  title: '会話',
  messages: [createUserMessage('message-1', 'こんにちは'), createAssistantMessage('message-2', 'こんばんは')],
}

const settings: Settings = {
  schemaVersion: '1.4.0',
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
  includeChatHistory: true,
  sendImagesOnlyOnce: true,
  sidebarOpen: true,
  templateModels: {},
}

describe('ChatMain', () => {
  beforeEach(() => {
    chatMessageListProps = null
    streamProcessorParams = null
    hasActiveChatSessionMock = false
    resumeActiveChatCompletionMock.mockResolvedValue(null)
    submitChatCompletionMock.mockResolvedValue({
      result: {
        message: {
          content: '編集後の回答',
          reasoningContent: '',
        },
        model: 'gpt-test',
        finishReason: 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
        },
      },
      responseTimeMs: 123,
    })
    useMessageScrollMock.mockReturnValue({
      scrollContainerRef: { current: null },
      bottomChatInputContainerRef: { current: null },
      messageEndRef: { current: null },
      isPinnedToBottom: true,
      handleScroll: vi.fn(),
      scrollToMessageEnd: scrollToMessageEndMock,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('active session がある場合は既存会話表示中でも復元を開始する', async () => {
    hasActiveChatSessionMock = true
    const resumedConversation: Conversation = {
      id: 'conversation-1',
      title: '会話',
      messages: [...currentConversation.messages, createUserMessage('message-3', '続きの質問')],
    }
    resumeActiveChatCompletionMock.mockResolvedValue({
      conversation: resumedConversation,
      assistantMessageId: 'message-4',
      result: {
        id: 'chunk-1',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: '続きの回答',
          reasoningContent: '',
        },
        usage: null,
      },
      responseTimeMs: 123,
    })
    const onConversationChange = vi.fn()
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    render(
      <ChatMain
        settings={settings}
        currentConversation={currentConversation}
        onConversationChange={onConversationChange}
      />
    )

    await waitFor(() => {
      expect(resumeActiveChatCompletionMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(onConversationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'conversation-1',
          messages: [
            expect.objectContaining({ id: 'message-1' }),
            expect.objectContaining({ id: 'message-2' }),
            expect.objectContaining({ id: 'message-3' }),
            expect.objectContaining({ id: 'message-4', content: '続きの回答' }),
          ],
        })
      )
    })
  })

  it('session replay 中に user_message を受けたら入力済みメッセージを即時表示する', async () => {
    const resumedConversation: Conversation = {
      id: 'conversation-1',
      title: '会話',
      messages: [createUserMessage('message-1', '送信済み質問')],
    }
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    render(<ChatMain settings={settings} />)

    const onSessionConversation = streamProcessorParams?.onSessionConversation as
      | ((conversation: Conversation, assistantMessageId: string) => void)
      | undefined
    expect(onSessionConversation).toBeTypeOf('function')

    onSessionConversation?.(resumedConversation, 'message-2')

    await waitFor(() => {
      expect(chatMessageListProps?.messages).toEqual(resumedConversation.messages)
      expect(chatMessageListProps?.streamMessageId).toBe('message-2')
    })
  })

  it('session replay 完了イベントを受けたら Promise 解決前に assistant メッセージを確定表示する', async () => {
    const resumedConversation: Conversation = {
      id: 'conversation-1',
      title: '会話',
      messages: [createUserMessage('message-1', '送信済み質問')],
    }
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    render(<ChatMain settings={settings} />)

    const onSessionConversation = streamProcessorParams?.onSessionConversation as
      | ((conversation: Conversation, assistantMessageId: string) => void)
      | undefined
    const onSessionResult = streamProcessorParams?.onSessionResult as
      | ((result: {
          conversation: Conversation
          assistantMessageId: string
          result: {
            id: string
            created: number
            model: string
            finishReason: string
            message: { content: string; reasoningContent: string }
            usage: null
          } | null
        }) => void)
      | undefined
    expect(onSessionConversation).toBeTypeOf('function')
    expect(onSessionResult).toBeTypeOf('function')

    onSessionConversation?.(resumedConversation, 'message-2')
    onSessionResult?.({
      conversation: resumedConversation,
      assistantMessageId: 'message-2',
      result: {
        id: 'chunk-1',
        created: 1700000000,
        model: 'gpt-test',
        finishReason: 'stop',
        message: {
          content: '復元後の回答',
          reasoningContent: '',
        },
        usage: null,
      },
    })

    await waitFor(() => {
      expect(chatMessageListProps?.messages).toEqual([
        expect.objectContaining({ id: 'message-1', role: 'user' }),
        expect.objectContaining({ id: 'message-2', role: 'assistant', content: '復元後の回答' }),
      ])
      expect(chatMessageListProps?.streamMessageId).toBeNull()
    })
  })

  it('session replay 復元後は同じ会話の古い currentConversation で上書きしない', async () => {
    const resumedConversation: Conversation = {
      id: 'conversation-1',
      title: '会話',
      messages: [...currentConversation.messages, createUserMessage('message-3', '続きの質問')],
    }
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    const view = render(<ChatMain settings={settings} currentConversation={null} />)

    const onSessionConversation = streamProcessorParams?.onSessionConversation as
      | ((conversation: Conversation, assistantMessageId: string) => void)
      | undefined
    expect(onSessionConversation).toBeTypeOf('function')

    onSessionConversation?.(resumedConversation, 'message-4')

    await waitFor(() => {
      expect(chatMessageListProps?.messages).toEqual(resumedConversation.messages)
      expect(chatMessageListProps?.streamMessageId).toBe('message-4')
    })

    view.rerender(<ChatMain settings={settings} currentConversation={currentConversation} />)

    await waitFor(() => {
      expect(chatMessageListProps?.messages).toEqual(resumedConversation.messages)
      expect(chatMessageListProps?.streamMessageId).toBe('message-4')
    })
  })

  it('session replay 復元後も別会話へ切り替えたら currentConversation を表示する', async () => {
    const resumedConversation: Conversation = {
      id: 'conversation-1',
      title: '会話',
      messages: [...currentConversation.messages, createUserMessage('message-3', '続きの質問')],
    }
    const nextConversation: Conversation = {
      id: 'conversation-2',
      title: '別会話',
      messages: [createUserMessage('message-5', '別の質問')],
    }
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    const view = render(<ChatMain settings={settings} currentConversation={null} />)

    const onSessionConversation = streamProcessorParams?.onSessionConversation as
      | ((conversation: Conversation, assistantMessageId: string) => void)
      | undefined
    expect(onSessionConversation).toBeTypeOf('function')

    onSessionConversation?.(resumedConversation, 'message-4')

    await waitFor(() => {
      expect(chatMessageListProps?.messages).toEqual(resumedConversation.messages)
    })

    view.rerender(<ChatMain settings={settings} currentConversation={nextConversation} />)

    await waitFor(() => {
      expect(chatMessageListProps?.messages).toEqual(nextConversation.messages)
      expect(chatMessageListProps?.streamMessageId).toBeNull()
    })
  })

  it('最下端に吸着している間は最新へ移動ボタンを表示しない', async () => {
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    render(<ChatMain settings={settings} currentConversation={currentConversation} />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-list')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: '最下部へ移動' })).toBeNull()
  })

  it('最下端から離れると最新へ移動ボタンを表示し、押下でスクロールする', async () => {
    useMessageScrollMock.mockReturnValue({
      scrollContainerRef: { current: null },
      bottomChatInputContainerRef: { current: null },
      messageEndRef: { current: null },
      isPinnedToBottom: false,
      handleScroll: vi.fn(),
      scrollToMessageEnd: scrollToMessageEndMock,
    })

    const { ChatMain } = await import('#/client/components/chat/chat-main')

    render(<ChatMain settings={settings} currentConversation={currentConversation} />)

    const button = await screen.findByRole('button', { name: '最下部へ移動' })
    fireEvent.click(button)

    expect(scrollToMessageEndMock).toHaveBeenCalledWith('smooth')
  })

  it('ユーザーメッセージ編集時は後続履歴を切り捨てて再生成結果を保存する', async () => {
    const onConversationChange = vi.fn()
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    render(
      <ChatMain
        settings={settings}
        currentConversation={currentConversation}
        onConversationChange={onConversationChange}
      />
    )

    await waitFor(() => {
      expect(chatMessageListProps?.onEditMessage).toBeTypeOf('function')
    })
    const onEditMessage = chatMessageListProps?.onEditMessage as (index: number, nextText: string) => Promise<void>
    await onEditMessage(0, '編集した質問')

    expect(submitChatCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: '編集した質問' }],
      })
    )
    await waitFor(() => {
      expect(onConversationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'conversation-1',
          title: '会話',
          messages: [
            expect.objectContaining({ id: 'message-1', role: 'user', content: '編集した質問' }),
            expect.objectContaining({ role: 'assistant', content: '編集後の回答' }),
          ],
        })
      )
    })
  })

  it('会話履歴を含めない編集時は送信対象を編集中メッセージに絞る', async () => {
    const conversation: Conversation = {
      ...currentConversation,
      messages: [
        createUserMessage('message-1', '最初の質問'),
        createAssistantMessage('message-2', '最初の回答'),
        createUserMessage('message-3', '次の質問'),
        createAssistantMessage('message-4', '次の回答'),
      ],
    }
    const onConversationChange = vi.fn()
    const { ChatMain } = await import('#/client/components/chat/chat-main')

    render(
      <ChatMain
        settings={{ ...settings, includeChatHistory: false }}
        currentConversation={conversation}
        onConversationChange={onConversationChange}
      />
    )

    await waitFor(() => {
      expect(chatMessageListProps?.onEditMessage).toBeTypeOf('function')
    })
    const onEditMessage = chatMessageListProps?.onEditMessage as (index: number, nextText: string) => Promise<void>
    await onEditMessage(2, '編集した次の質問')

    expect(submitChatCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: '編集した次の質問' }],
      })
    )
    await waitFor(() => {
      expect(onConversationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({ id: 'message-1', role: 'user', content: '最初の質問' }),
            expect.objectContaining({ id: 'message-2', role: 'assistant', content: '最初の回答' }),
            expect.objectContaining({ id: 'message-3', role: 'user', content: '編集した次の質問' }),
            expect.objectContaining({ role: 'assistant', content: '編集後の回答' }),
          ],
        })
      )
    })
  })
})
