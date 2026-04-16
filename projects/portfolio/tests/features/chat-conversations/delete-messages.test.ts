import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../../helpers/mock-logger'

const importSubject = async (params: {
  validIds: string[]
  users: Array<{ id: string; email: string }>
  ownedMessages: Array<{ id: string; conversationId: string }>
  remainingResponses?: Array<Array<{ id: string }>>
  transactionShouldFail?: boolean
}) => {
  mockLogger()
  const deleteCalls: unknown[] = []
  let remainingCall = 0
  const remainingResponses = params.remainingResponses ?? []

  const tx = {
    delete: vi.fn((table: unknown) => ({
      where: vi.fn().mockImplementation(async (value: unknown) => {
        deleteCalls.push({ table, value })
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockImplementation(async () => remainingResponses[remainingCall++] ?? []),
        })),
      })),
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
          innerJoin: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(params.ownedMessages),
          })),
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

  const { deleteMessages } = await import('#/server/features/chat-conversations/delete-messages')
  return { deleteMessages, deleteCalls }
}

describe('deleteMessages', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('空配列は成功で早期 return する', async () => {
    const { deleteMessages } = await importSubject({
      validIds: [],
      users: [],
      ownedMessages: [],
    })

    await expect(deleteMessages('postgres://db', 'test@example.com', [])).resolves.toEqual({
      success: true,
      deletedMessageIds: [],
      failedMessageIds: [],
      deletedConversationIds: [],
    })
  })

  it('有効な UUID がない場合は failedMessageIds を返す', async () => {
    const { deleteMessages } = await importSubject({
      validIds: [],
      users: [],
      ownedMessages: [],
    })

    await expect(deleteMessages('postgres://db', 'test@example.com', ['invalid-id'])).resolves.toEqual({
      success: false,
      deletedMessageIds: [],
      failedMessageIds: ['invalid-id'],
      deletedConversationIds: [],
    })
  })

  it('最後の message を消した conversation も削除する', async () => {
    const { deleteMessages, deleteCalls } = await importSubject({
      validIds: ['message-1', 'message-2'],
      users: [{ id: 'user-1', email: 'test@example.com' }],
      ownedMessages: [
        { id: 'message-1', conversationId: 'conversation-1' },
        { id: 'message-2', conversationId: 'conversation-2' },
      ],
      remainingResponses: [[{ id: 'message-3' }], []],
    })

    await expect(deleteMessages('postgres://db', 'test@example.com', ['message-1', 'message-2'])).resolves.toEqual({
      success: true,
      deletedMessageIds: ['message-1', 'message-2'],
      failedMessageIds: [],
      deletedConversationIds: ['conversation-2'],
    })
    expect(deleteCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('transaction 失敗時は全件失敗で返す', async () => {
    const { deleteMessages } = await importSubject({
      validIds: ['message-1'],
      users: [{ id: 'user-1', email: 'test@example.com' }],
      ownedMessages: [{ id: 'message-1', conversationId: 'conversation-1' }],
      transactionShouldFail: true,
    })

    await expect(deleteMessages('postgres://db', 'test@example.com', ['message-1'])).resolves.toEqual({
      success: false,
      deletedMessageIds: [],
      failedMessageIds: ['message-1'],
      deletedConversationIds: [],
    })
  })
})
