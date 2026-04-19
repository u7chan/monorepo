import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../../helpers/mock-logger'

const importSubject = async (params: {
  users: Array<{ id: string; email: string }>
  ownedRow?: {
    messageId: string
    role: string
    metadata: unknown
    conversationUserId: string
  }
}) => {
  mockLogger()
  const updateSets: unknown[] = []
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
            where: vi.fn().mockResolvedValue(params.ownedRow ? [params.ownedRow] : []),
          })),
        })),
      }
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updateSets.push(values)
        return { where: vi.fn().mockResolvedValue(undefined) }
      }),
    })),
  }

  vi.doMock('#/db', () => ({
    getDatabase: vi.fn(() => db),
  }))

  const { updateMessageMetadata } = await import('#/server/features/chat-conversations/update-message-metadata')
  return { updateMessageMetadata, updateSets }
}

describe('updateMessageMetadata', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('ユーザーが居なければ user-not-found を返す', async () => {
    const { updateMessageMetadata } = await importSubject({ users: [] })

    const result = await updateMessageMetadata('postgres://db', 'x@example.com', {
      conversationId: 'c1',
      messageId: 'm1',
      metadataPatch: { finishReason: 'stop' },
    })

    expect(result).toEqual({ ok: false, reason: 'user-not-found' })
  })

  it('message が無ければ message-not-found を返す', async () => {
    const { updateMessageMetadata } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: undefined,
    })

    const result = await updateMessageMetadata('postgres://db', 'x@example.com', {
      conversationId: 'c1',
      messageId: 'm1',
      metadataPatch: {},
    })

    expect(result).toEqual({ ok: false, reason: 'message-not-found' })
  })

  it('他ユーザーの conversation には forbidden を返す', async () => {
    const { updateMessageMetadata } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'assistant',
        metadata: {},
        conversationUserId: 'other-user',
      },
    })

    const result = await updateMessageMetadata('postgres://db', 'x@example.com', {
      conversationId: 'c1',
      messageId: 'm1',
      metadataPatch: {},
    })

    expect(result).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('assistant 以外は invalid-role を返す', async () => {
    const { updateMessageMetadata } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'user',
        metadata: {},
        conversationUserId: 'u1',
      },
    })

    const result = await updateMessageMetadata('postgres://db', 'x@example.com', {
      conversationId: 'c1',
      messageId: 'm1',
      metadataPatch: {},
    })

    expect(result).toEqual({ ok: false, reason: 'invalid-role' })
  })

  it('usage を patch するとき既存フィールドを deep merge する', async () => {
    const { updateMessageMetadata, updateSets } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'assistant',
        metadata: { model: 'gpt', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
        conversationUserId: 'u1',
      },
    })

    await updateMessageMetadata('postgres://db', 'x@example.com', {
      conversationId: 'c1',
      messageId: 'm1',
      metadataPatch: { usage: { completionTokens: 1 } },
    })

    expect(updateSets[0]).toEqual({
      metadata: {
        model: 'gpt',
        usage: { promptTokens: 100, completionTokens: 1, totalTokens: 150 },
      },
    })
  })

  it('既存 metadata を壊さず merge して保存する', async () => {
    const { updateMessageMetadata, updateSets } = await importSubject({
      users: [{ id: 'u1', email: 'x@example.com' }],
      ownedRow: {
        messageId: 'm1',
        role: 'assistant',
        metadata: { model: 'gpt', usage: { totalTokens: 10 } },
        conversationUserId: 'u1',
      },
    })

    const result = await updateMessageMetadata('postgres://db', 'x@example.com', {
      conversationId: 'c1',
      messageId: 'm1',
      metadataPatch: { finishReason: 'stop' },
    })

    expect(result.ok).toBe(true)
    expect(updateSets[0]).toEqual({
      metadata: {
        model: 'gpt',
        usage: { totalTokens: 10 },
        finishReason: 'stop',
      },
    })
  })
})
