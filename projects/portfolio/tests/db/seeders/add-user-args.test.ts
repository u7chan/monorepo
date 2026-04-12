import { addUserUsage, parseAddUserArgs } from '#/db/seeders/add-user-args'
import { describe, expect, it } from 'vitest'

describe('parseAddUserArgs', () => {
  it('email を受け取って返す', () => {
    expect(parseAddUserArgs(['bun', 'src/db/seeders/add-user.ts', '--email', 'test@example.com'])).toEqual({
      email: 'test@example.com',
    })
  })

  it('email がない場合は usage error を投げる', () => {
    expect(() => parseAddUserArgs(['bun', 'src/db/seeders/add-user.ts'])).toThrow(addUserUsage)
  })

  it('--password が指定された場合は usage error を投げる', () => {
    expect(() =>
      parseAddUserArgs(['bun', 'src/db/seeders/add-user.ts', '--email', 'test@example.com', '--password', 'testpass'])
    ).toThrow(addUserUsage)
  })

  it('未知の引数がある場合は usage error を投げる', () => {
    expect(() =>
      parseAddUserArgs(['bun', 'src/db/seeders/add-user.ts', '--email', 'test@example.com', '--unknown', 'value'])
    ).toThrow(addUserUsage)
  })
})
