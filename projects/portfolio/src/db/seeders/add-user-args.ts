import { z } from 'zod'

export const addUserUsage = 'Usage: bun run db:user:add -- --email <email>'

const AddUserArgsSchema = z.object({
  email: z.email(),
})

export interface AddUserArgs {
  email: string
}

export function parseAddUserArgs(argv: string[]): AddUserArgs {
  const args = argv.slice(2)
  let email = ''

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const value = args[index + 1]

    if (arg === '--email' && value) {
      email = value
      index++
      continue
    }

    throw new Error(addUserUsage)
  }

  const parsed = AddUserArgsSchema.safeParse({ email })

  if (!parsed.success) {
    throw new Error(addUserUsage)
  }

  return parsed.data
}
