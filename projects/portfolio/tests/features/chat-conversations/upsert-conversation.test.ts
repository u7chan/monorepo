import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '../../helpers/mock-logger'

const importSubject = async (params: {
  users: Array<{ id: string; email: string }>
  existingConversations: Array<{ id: string }>
}) => {
  mockLogger()
  const insertValues: unknown[] = []
  const updateSets: unknown[] = []
  const deleteWheres: unknown[] = []

  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(params.existingConversations),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        insertValues.push(values)
        return Promise.resolve()
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updateSets.push(values)
        return {
          where: vi.fn().mockResolvedValue(undefined),
        }
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((where: unknown) => {
        deleteWheres.push(where)
        return Promise.resolve()
      }),
    })),
  }

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(params.users),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: any) => Promise<void>) => callback(tx)),
  }

  const uuidv7 = vi.fn(() => 'generated-message-id')

  vi.doMock('#/db', () => ({
    getDatabase: vi.fn(() => db),
  }))
  vi.doMock('uuidv7', () => ({
    uuidv7,
  }))

  const { upsertConversation } = await import('#/server/features/chat-conversations/upsert-conversation')

  return {
    upsertConversation,
    insertValues,
    updateSets,
    deleteWheres,
    uuidv7,
  }
}

describe('upsertConversation', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('ユーザーが存在しない場合は null を返す', async () => {
    const { upsertConversation } = await importSubject({
      users: [],
      existingConversations: [],
    })

    await expect(
      upsertConversation('postgres://db', 'missing@example.com', {
        id: 'conversation-1',
        title: 'title',
        messages: [],
      })
    ).resolves.toBeNull()
  })

  it('新規会話は insert し message を保存する', async () => {
    const { upsertConversation, insertValues, uuidv7 } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      existingConversations: [],
    })

    await upsertConversation('postgres://db', 'test@example.com', {
      id: 'conversation-1',
      title: 'title',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          reasoningContent: 'thinking',
          metadata: { model: 'gpt-test' },
        },
      ],
    })

    expect(insertValues[0]).toMatchObject({
      id: 'conversation-1',
      userId: 'user-1',
      title: 'title',
    })
    expect(insertValues[1]).toEqual([
      expect.objectContaining({
        id: 'generated-message-id',
        conversationId: 'conversation-1',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'hello' }]),
        reasoningContent: 'thinking',
        // metadata は jsonb カラムにオブジェクトのまま渡す（JSON.stringify しない）
        metadata: { model: 'gpt-test' },
      }),
    ])
    expect(uuidv7).toHaveBeenCalled()
  })

  it('message.id が指定されていれば既存 id を保持する', async () => {
    const { upsertConversation, insertValues, uuidv7 } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      existingConversations: [],
    })

    await upsertConversation('postgres://db', 'test@example.com', {
      id: 'conversation-1',
      title: 'title',
      messages: [
        {
          id: 'keep-this-id',
          role: 'assistant',
          content: 'hi',
          metadata: { model: 'gpt-test', usage: {} },
        },
        {
          role: 'user',
          content: 'no id',
          reasoningContent: '',
          metadata: { model: '' },
        },
      ],
    })

    expect(insertValues[1]).toEqual([
      expect.objectContaining({ id: 'keep-this-id' }),
      expect.objectContaining({ id: 'generated-message-id' }),
    ])
    // 既存 id を持つ message では uuidv7 を呼ばないこと
    expect(uuidv7).toHaveBeenCalledTimes(1)
  })

  it('既存会話は updatedAt を更新し、既存 message を削除して全件再挿入する', async () => {
    const { upsertConversation, updateSets, insertValues, deleteWheres } = await importSubject({
      users: [{ id: 'user-1', email: 'test@example.com' }],
      existingConversations: [{ id: 'conversation-1' }],
    })

    await upsertConversation('postgres://db', 'test@example.com', {
      id: 'conversation-1',
      title: 'title',
      messages: [
        {
          role: 'assistant',
          content: 'hello',
          metadata: {
            model: 'gpt-test',
            usage: {},
          },
        },
      ],
    })

    expect(updateSets[0]).toEqual({
      updatedAt: expect.any(Date),
    })
    // 既存 message が削除されること（重複 insert 防止）
    expect(deleteWheres).toHaveLength(1)
    // 全件挿入が1回呼ばれること
    expect(insertValues).toHaveLength(1)
  })
})
