import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../../helpers/mock-logger'

const importSubject = async (params: {
  validIds: string[]
  users: Array<{ id: string; email: string }>
  ownedConversationIds: string[]
  transactionShouldFail?: boolean
}) => {
  mockLogger()
  const tx = {
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }

  let selectCall = 0
  const db = {
    select: vi.fn(() => {
      selectCall += 1

      if (selectCall === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(params.users),
          })),
        }
      }

      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(params.ownedConversationIds.map((id) => ({ id }))),
        })),
      }
    }),
    transaction: vi.fn(async (callback: (tx: any) => Promise<void>) => {
      if (params.transactionShouldFail) {
        throw new Error('transaction failed')
      }
      await callback(tx)
    }),
  }

  const parse = vi.fn((id: string) => {
    if (!params.validIds.includes(id)) {
      throw new Error('invalid uuid')
    }
    return id
  })

  vi.doMock('#/db', () => ({
    getDatabase: vi.fn(() => db),
  }))
  vi.doMock('uuidv7', () => ({
    UUID: {
      parse,
    },
  }))

  const { deleteConversations } = await import('#/server/features/chat-conversations/delete-conversations')
  return { deleteConversations, tx }
}

describe('deleteConversations', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('空配列は成功で早期 return する', async () => {
    const { deleteConversations } = await importSubject({
      validIds: [],
      users: [],
      ownedConversationIds: [],
    })

    await expect(deleteConversations('postgres://db', 'test@example.com', [])).resolves.toEqual({
      success: true,
      deletedIds: [],
      failedIds: [],
    })
  })

  it('有効な UUID がない場合は failedIds を返す', async () => {
    const { deleteConversations } = await importSubject({
      validIds: [],
      users: [],
      ownedConversationIds: [],
    })

    await expect(deleteConversations('postgres://db', 'test@example.com', ['invalid-id'])).resolves.toEqual({
      success: false,
      deletedIds: [],
      failedIds: ['invalid-id'],
    })
  })

  it('所有している会話だけを削除し unauthorized を failedIds に返す', async () => {
    const { deleteConversations, tx } = await importSubject({
      validIds: ['conversation-1', 'conversation-2'],
      users: [{ id: 'user-1', email: 'test@example.com' }],
      ownedConversationIds: ['conversation-1'],
    })

    await expect(
      deleteConversations('postgres://db', 'test@example.com', ['conversation-1', 'conversation-2'])
    ).resolves.toEqual({
      success: true,
      deletedIds: ['conversation-1'],
      failedIds: ['conversation-2'],
    })
    expect(tx.delete).toHaveBeenCalledTimes(2)
  })

  it('transaction 失敗時は全件失敗で返す', async () => {
    const { deleteConversations } = await importSubject({
      validIds: ['conversation-1'],
      users: [{ id: 'user-1', email: 'test@example.com' }],
      ownedConversationIds: ['conversation-1'],
      transactionShouldFail: true,
    })

    await expect(deleteConversations('postgres://db', 'test@example.com', ['conversation-1'])).resolves.toEqual({
      success: false,
      deletedIds: [],
      failedIds: ['conversation-1'],
    })
  })
})
