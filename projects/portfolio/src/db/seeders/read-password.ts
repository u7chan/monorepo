import { stderr, stdin } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

export const passwordPrompt = 'Password: '
export const passwordRequiredMessage = 'Password is required'

type PasswordInput = NodeJS.ReadableStream & {
  isTTY?: boolean
}

type PasswordOutput = NodeJS.WritableStream

interface ReadPasswordOptions {
  input?: PasswordInput
  output?: PasswordOutput
  promptPassword?: (options?: PromptPasswordOptions) => Promise<string>
  readPasswordFromStdin?: (input?: PasswordInput) => Promise<string>
}

interface PromptPasswordOptions {
  input?: PasswordInput
  output?: PasswordOutput
}

export async function readPassword(options: ReadPasswordOptions = {}) {
  const input = options.input ?? stdin
  const promptPassword = options.promptPassword ?? readPasswordFromPrompt
  const readPasswordFromStdin = options.readPasswordFromStdin ?? readPasswordViaStdin

  if (input.isTTY) {
    return promptPassword({
      input,
      output: options.output,
    })
  }

  return readPasswordFromStdin(input)
}

export async function readPasswordFromPrompt(options: PromptPasswordOptions = {}) {
  const input = options.input ?? stdin
  const output = options.output ?? stderr
  const mutedOutput = new MutedWriteStream(output)
  const reader = createInterface({
    input,
    output: mutedOutput,
    terminal: true,
  })

  try {
    const question = reader.question(passwordPrompt)
    mutedOutput.muted = true
    const password = await question

    output.write('\n')

    return validatePassword(password)
  } finally {
    reader.close()
  }
}

export async function readPasswordViaStdin(input: PasswordInput = stdin) {
  const chunks: Buffer[] = []

  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }

  return validatePassword(
    Buffer.concat(chunks)
      .toString('utf8')
      .replace(/[\r\n]+$/, '')
  )
}

function validatePassword(password: string) {
  if (password.length === 0) {
    throw new Error(passwordRequiredMessage)
  }

  return password
}

class MutedWriteStream extends Writable {
  muted = false

  constructor(private readonly target: PasswordOutput) {
    super()
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!this.muted) {
      if (typeof chunk === 'string') {
        this.target.write(chunk, encoding)
      } else {
        this.target.write(chunk)
      }
    }

    callback()
  }
}
