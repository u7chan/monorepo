import { getDatabase } from '#/db'
import { addUser, UserAlreadyExistsError } from '#/db/seeders/add-user-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('#/db', () => ({
  getDatabase: vi.fn(),
}))

const mockedGetDatabase = vi.mocked(getDatabase)

function createDbStub(existingUsers: Array<{ id: string }>) {
  const where = vi.fn().mockResolvedValue(existingUsers)
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  const values = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn(() => ({ values }))

  return {
    db: { select, insert },
    select,
    from,
    where,
    insert,
    values,
  }
}

describe('addUser', () => {
  beforeEach(() => {
    mockedGetDatabase.mockReset()
  })

  it('同じメールアドレスのユーザーがいなければ追加する', async () => {
    const { db, insert, values } = createDbStub([])
    mockedGetDatabase.mockReturnValue(db as never)

    await expect(
      addUser({
        databaseUrl: 'postgres://db',
        email: 'test@example.com',
        passwordHash: 'hashed-password',
      })
    ).resolves.toBeUndefined()

    expect(mockedGetDatabase).toHaveBeenCalledWith('postgres://db')
    expect(insert).toHaveBeenCalledTimes(1)
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@example.com',
        passwordHash: 'hashed-password',
      })
    )
  })

  it('同じメールアドレスのユーザーがいれば UserAlreadyExistsError を投げる', async () => {
    const { db, insert } = createDbStub([{ id: 'user-1' }])
    mockedGetDatabase.mockReturnValue(db as never)

    await expect(
      addUser({
        databaseUrl: 'postgres://db',
        email: 'test@example.com',
        passwordHash: 'hashed-password',
      })
    ).rejects.toBeInstanceOf(UserAlreadyExistsError)

    expect(insert).not.toHaveBeenCalled()
  })

  it('insert で users.email の一意制約違反が起きた場合は UserAlreadyExistsError を投げる', async () => {
    const { db, values } = createDbStub([])
    mockedGetDatabase.mockReturnValue(db as never)
    values.mockRejectedValueOnce({
      code: '23505',
      constraint: 'users_email_unique',
    })

    await expect(
      addUser({
        databaseUrl: 'postgres://db',
        email: 'test@example.com',
        passwordHash: 'hashed-password',
      })
    ).rejects.toBeInstanceOf(UserAlreadyExistsError)
  })

  it('insert で別のエラーが起きた場合はそのまま投げる', async () => {
    const { db, values } = createDbStub([])
    const expectedError = new Error('database unavailable')
    mockedGetDatabase.mockReturnValue(db as never)
    values.mockRejectedValueOnce(expectedError)

    await expect(
      addUser({
        databaseUrl: 'postgres://db',
        email: 'test@example.com',
        passwordHash: 'hashed-password',
      })
    ).rejects.toBe(expectedError)
  })
})
