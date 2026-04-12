import { z } from 'zod'

const usage = 'Usage: bun run db:user:add -- --email <email> --password <password>'

const AddUserArgsSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})

export interface AddUserArgs {
  email: string
  password: string
}

export function parseAddUserArgs(argv: string[]): AddUserArgs {
  const args = argv.slice(2)
  let email = ''
  let password = ''

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const value = args[index + 1]

    if (arg === '--email' && value) {
      email = value
      index++
      continue
    }

    if (arg === '--password' && value) {
      password = value
      index++
      continue
    }

    throw new Error(usage)
  }

  const parsed = AddUserArgsSchema.safeParse({ email, password })

  if (!parsed.success) {
    throw new Error(usage)
  }

  return parsed.data
}
