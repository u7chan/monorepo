import { describe, expect, it, vi } from 'vitest'
import { beginChatTurn, completeChatTurn } from '#/client/features/chat/lib/chat-turn'
import type { Conversation, Message } from '#/types'

const userMessage: Message = { id: 'user-1', role: 'user', content: 'hello', metadata: { model: 'gpt-test' } }
const assistantMessage: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'hi',
  metadata: { model: 'gpt-test', usage: {} },
}

const createSetters = () => ({
  markSessionOwnedSnapshot: vi.fn(),
  setConversationId: vi.fn(),
  setMessages: vi.fn(),
  setStreamMessageId: vi.fn(),
  setIsSavingConversation: vi.fn(),
})

describe('beginChatTurn', () => {
  it('下書き会話を snapshot に反映してから、生成中のメッセージ ID を立てる', () => {
    const setters = createSetters()

    const started = beginChatTurn({
      conversationId: 'conversation-1',
      title: 'title',
      messages: [userMessage],
      ...setters,
    })

    expect(started.conversationId).toBe('conversation-1')
    expect(started.draftConversation).toEqual({ id: 'conversation-1', title: 'title', messages: [userMessage] })
    expect(started.assistantMessageId).toBeTruthy()
    expect(setters.markSessionOwnedSnapshot).toHaveBeenCalledWith({
      id: 'conversation-1',
      title: 'title',
      messages: [userMessage],
    })
    expect(setters.setConversationId).toHaveBeenCalledWith('conversation-1')
    expect(setters.setMessages).toHaveBeenCalledWith([userMessage])
    expect(setters.setStreamMessageId).toHaveBeenCalledWith(started.assistantMessageId)

    const order = [
      setters.markSessionOwnedSnapshot.mock.invocationCallOrder[0],
      setters.setConversationId.mock.invocationCallOrder[0],
      setters.setMessages.mock.invocationCallOrder[0],
      setters.setStreamMessageId.mock.invocationCallOrder[0],
    ]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('会話 ID が無ければ新しく採番して返す', () => {
    const setters = createSetters()

    const started = beginChatTurn({ conversationId: null, title: 'title', messages: [userMessage], ...setters })

    expect(started.conversationId).toBeTruthy()
    expect(started.draftConversation.id).toBe(started.conversationId)
    expect(setters.setConversationId).toHaveBeenCalledWith(started.conversationId)
  })
})

describe('completeChatTurn', () => {
  const conversation: Pick<Conversation, 'id' | 'title'> = { id: 'conversation-1', title: 'title' }

  it('非ストリームでは会話の保存を conversation change に委ね、保存中フラグを戻す', async () => {
    const setters = createSetters()
    const onConversationChange = vi.fn()
    const onSessionCompleted = vi.fn()

    await completeChatTurn({
      conversation,
      messages: [userMessage, assistantMessage],
      useSessionCompletion: false,
      onConversationChange,
      onSessionCompleted,
      ...setters,
    })

    expect(onConversationChange).toHaveBeenCalledWith({
      id: 'conversation-1',
      title: 'title',
      messages: [userMessage, assistantMessage],
    })
    expect(onSessionCompleted).not.toHaveBeenCalled()
    expect(setters.setIsSavingConversation.mock.calls).toEqual([[true], [false]])
  })

  it('ストリームでは session 完了のコールバックへ会話を渡す', async () => {
    const setters = createSetters()
    const onConversationChange = vi.fn()
    const onSessionCompleted = vi.fn()

    await completeChatTurn({
      conversation,
      messages: [userMessage],
      useSessionCompletion: true,
      onConversationChange,
      onSessionCompleted,
      ...setters,
    })

    expect(onSessionCompleted).toHaveBeenCalledWith({ id: 'conversation-1', title: 'title', messages: [userMessage] })
    expect(onConversationChange).not.toHaveBeenCalled()
  })

  it('保存が失敗しても保存中フラグを戻す', async () => {
    const setters = createSetters()
    const onConversationChange = vi.fn().mockRejectedValue(new Error('save failed'))

    await expect(
      completeChatTurn({
        conversation,
        messages: [userMessage],
        useSessionCompletion: false,
        onConversationChange,
        ...setters,
      })
    ).rejects.toThrow('save failed')

    expect(setters.setIsSavingConversation.mock.calls).toEqual([[true], [false]])
  })
})
