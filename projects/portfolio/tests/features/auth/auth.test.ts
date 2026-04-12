import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('#/db', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('#/server/features/auth/password-hash', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/server/features/auth/password-hash')>()

  return {
    ...actual,
    verifyPassword: vi.fn(actual.verifyPassword),
  }
})

import { getDatabase } from '#/db'
import { AuthenticationError, auth } from '#/server/features/auth/auth'
import { hashPassword, verifyPassword } from '#/server/features/auth/password-hash'

const mockedGetDatabase = vi.mocked(getDatabase)
const mockedVerifyPassword = vi.mocked(verifyPassword)

const createDbStub = (users: Array<{ id: string; email: string; passwordHash: string | null }>) => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(users),
    })),
  })),
})

describe('auth.login', () => {
  beforeEach(() => {
    mockedGetDatabase.mockReset()
    mockedVerifyPassword.mockClear()
  })

  it('ユーザーが存在し password_hash が一致すれば成功する', async () => {
    mockedGetDatabase.mockReturnValue(
      createDbStub([{ id: 'user-1', email: 'test@example.com', passwordHash: hashPassword('testexample') }]) as never
    )

    await expect(auth.login('postgres://db', 'test@example.com', 'testexample')).resolves.toBeUndefined()
    expect(mockedGetDatabase).toHaveBeenCalledWith('postgres://db')
  })

  it('ユーザーが存在しない場合もダミーハッシュを検証して AuthenticationError を投げる', async () => {
    mockedGetDatabase.mockReturnValue(createDbStub([]) as never)

    await expect(auth.login('postgres://db', 'missing@example.com', 'testexample')).rejects.toBeInstanceOf(
      AuthenticationError
    )
    expect(mockedVerifyPassword).toHaveBeenCalledTimes(1)
  })

  it('password_hash が未設定の場合もダミーハッシュを検証して AuthenticationError を投げる', async () => {
    mockedGetDatabase.mockReturnValue(
      createDbStub([{ id: 'user-1', email: 'test@example.com', passwordHash: null }]) as never
    )

    await expect(auth.login('postgres://db', 'test@example.com', 'testexample')).rejects.toBeInstanceOf(
      AuthenticationError
    )
    expect(mockedVerifyPassword).toHaveBeenCalledTimes(1)
  })

  it('password が一致しない場合は AuthenticationError を投げる', async () => {
    mockedGetDatabase.mockReturnValue(
      createDbStub([{ id: 'user-1', email: 'test@example.com', passwordHash: hashPassword('testexample') }]) as never
    )

    await expect(auth.login('postgres://db', 'test@example.com', 'wrong-password')).rejects.toBeInstanceOf(
      AuthenticationError
    )
  })
})
