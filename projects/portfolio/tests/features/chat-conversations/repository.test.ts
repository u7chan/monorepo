import { beforeEach, describe, expect, it, vi } from 'vitest'

const importSubject = async () => {
  const readConversations = vi.fn()
  const upsertConversation = vi.fn()
  const deleteConversations = vi.fn()
  const deleteMessages = vi.fn()

  vi.doMock('#/server/features/chat-conversations/read-conversations', () => ({
    readConversations,
  }))
  vi.doMock('#/server/features/chat-conversations/upsert-conversation', () => ({
    upsertConversation,
  }))
  vi.doMock('#/server/features/chat-conversations/delete-conversations', () => ({
    deleteConversations,
  }))
  vi.doMock('#/server/features/chat-conversations/delete-messages', () => ({
    deleteMessages,
  }))

  const { chatConversationRepository } = await import('#/server/features/chat-conversations/repository')

  return {
    chatConversationRepository,
    readConversations,
    upsertConversation,
    deleteConversations,
    deleteMessages,
  }
}

describe('chatConversationRepository', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('read を委譲する', async () => {
    const { chatConversationRepository, readConversations } = await importSubject()
    readConversations.mockResolvedValue([{ id: 'conversation-1', title: 'title', messages: [] }])

    await chatConversationRepository.read('postgres://db', 'test@example.com', 'http://files.example.com')

    expect(readConversations).toHaveBeenCalledWith('postgres://db', 'test@example.com', 'http://files.example.com')
  })

  it('upsert を委譲する', async () => {
    const { chatConversationRepository, upsertConversation } = await importSubject()

    await chatConversationRepository.upsert('postgres://db', 'test@example.com', {
      id: 'conversation-1',
      title: 'title',
      messages: [],
    })

    expect(upsertConversation).toHaveBeenCalled()
  })

  it('delete を委譲する', async () => {
    const { chatConversationRepository, deleteConversations } = await importSubject()
    deleteConversations.mockResolvedValue({ success: true, deletedIds: [], failedIds: [] })

    await chatConversationRepository.delete('postgres://db', 'test@example.com', ['conversation-1'])

    expect(deleteConversations).toHaveBeenCalledWith('postgres://db', 'test@example.com', ['conversation-1'])
  })

  it('deleteMessages を委譲する', async () => {
    const { chatConversationRepository, deleteMessages } = await importSubject()
    deleteMessages.mockResolvedValue({
      success: true,
      deletedMessageIds: [],
      failedMessageIds: [],
      deletedConversationIds: [],
    })

    await chatConversationRepository.deleteMessages('postgres://db', 'test@example.com', ['message-1'])

    expect(deleteMessages).toHaveBeenCalledWith('postgres://db', 'test@example.com', ['message-1'])
  })
})
