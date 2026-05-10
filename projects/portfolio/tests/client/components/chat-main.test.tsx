// @vitest-environment jsdom

import type { Settings } from '#/client/storage/remote-storage-settings'
import type { AssistantMessage, Conversation, UserMessage } from '#/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useMessageScrollMock = vi.fn()
const scrollToMessageEndMock = vi.fn()
const submitChatCompletionMock = vi.fn()
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
  useStreamProcessor: () => ({
    loading: false,
    stream: null,
    cancelStream: vi.fn(),
    submitChatCompletion: submitChatCompletionMock,
  }),
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
