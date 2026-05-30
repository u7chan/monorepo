import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabase } from '#/db'
import { promptTemplatesTable } from '#/db/schema'
import { defaultPromptTemplates } from '#/db/seeders/prompt-template-defaults'
import { upsertPromptTemplates } from '#/db/seeders/upsert-prompt-templates'

vi.mock('#/db', () => ({
  getDatabase: vi.fn(),
}))

const mockedGetDatabase = vi.mocked(getDatabase)

function createDbStub() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined)
  const values = vi.fn(() => ({ onConflictDoUpdate }))
  const insert = vi.fn(() => ({ values }))

  return {
    db: { insert },
    insert,
    values,
    onConflictDoUpdate,
  }
}

describe('upsertPromptTemplates', () => {
  beforeEach(() => {
    mockedGetDatabase.mockReset()
  })

  it('既定テンプレートを安定IDで upsert する', async () => {
    const { db, insert, values, onConflictDoUpdate } = createDbStub()
    mockedGetDatabase.mockReturnValue(db as never)

    await expect(upsertPromptTemplates({ databaseUrl: 'postgres://db' })).resolves.toBe(defaultPromptTemplates.length)

    expect(mockedGetDatabase).toHaveBeenCalledWith('postgres://db')
    expect(insert).toHaveBeenCalledTimes(defaultPromptTemplates.length)
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'translate_en',
        enabled: true,
        displayOrder: 10,
      })
    )
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: promptTemplatesTable.id,
        set: expect.objectContaining({
          enabled: true,
          title: '🇺🇸 英語へ翻訳',
        }),
      })
    )
  })
})
