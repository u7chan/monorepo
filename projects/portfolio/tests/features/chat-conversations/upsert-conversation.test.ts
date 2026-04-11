import { beforeEach, describe, expect, it, vi } from 'vitest'

const importSubject = async (params: {
  users: Array<{ id: string; email: string }>
  existingConversations: Array<{ id: string }>
}) => {
  const insertValues: unknown[] = []
  const updateSets: unknown[] = []

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

  it('既存会話は updatedAt を更新して message を追加する', async () => {
    const { upsertConversation, updateSets, insertValues } = await importSubject({
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

    expect(insertValues).toHaveLength(1)
    expect(updateSets[0]).toEqual({
      updatedAt: expect.any(Date),
    })
  })
})
