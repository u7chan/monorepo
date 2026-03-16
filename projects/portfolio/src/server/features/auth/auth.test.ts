import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('#/db', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '#/db'
import { AuthenticationError, auth } from './auth'

const mockedGetDatabase = vi.mocked(getDatabase)

const createDbStub = (users: Array<{ id: string; email: string }>) => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(users),
    })),
  })),
})

describe('auth.login', () => {
  beforeEach(() => {
    mockedGetDatabase.mockReset()
  })

  it('ユーザーが存在し password が一致すれば成功する', async () => {
    mockedGetDatabase.mockReturnValue(createDbStub([{ id: 'user-1', email: 'test@example.com' }]) as never)

    await expect(auth.login('postgres://db', 'test@example.com', 'testexample')).resolves.toBeUndefined()
    expect(mockedGetDatabase).toHaveBeenCalledWith('postgres://db')
  })

  it('ユーザーが存在しない場合は AuthenticationError を投げる', async () => {
    mockedGetDatabase.mockReturnValue(createDbStub([]) as never)

    await expect(auth.login('postgres://db', 'missing@example.com', 'testexample')).rejects.toBeInstanceOf(
      AuthenticationError
    )
  })

  it('password が一致しない場合は AuthenticationError を投げる', async () => {
    mockedGetDatabase.mockReturnValue(createDbStub([{ id: 'user-1', email: 'test@example.com' }]) as never)

    await expect(auth.login('postgres://db', 'test@example.com', 'wrong-password')).rejects.toBeInstanceOf(
      AuthenticationError
    )
  })
})
