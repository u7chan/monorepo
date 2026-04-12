import { parseAddUserArgs } from '#/db/seeders/add-user-args'
import { describe, expect, it } from 'vitest'

describe('parseAddUserArgs', () => {
  it('email と password を受け取って返す', () => {
    expect(
      parseAddUserArgs(['bun', 'src/db/seeders/add-user.ts', '--email', 'test@example.com', '--password', 'testpass'])
    ).toEqual({
      email: 'test@example.com',
      password: 'testpass',
    })
  })

  it('email がない場合は usage error を投げる', () => {
    expect(() => parseAddUserArgs(['bun', 'src/db/seeders/add-user.ts', '--password', 'testpass'])).toThrow(
      'Usage: bun run db:user:add -- --email <email> --password <password>'
    )
  })

  it('未知の引数がある場合は usage error を投げる', () => {
    expect(() =>
      parseAddUserArgs(['bun', 'src/db/seeders/add-user.ts', '--email', 'test@example.com', '--unknown', 'value'])
    ).toThrow('Usage: bun run db:user:add -- --email <email> --password <password>')
  })
})
