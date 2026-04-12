import { PassThrough, Writable } from 'node:stream'
import {
  passwordPrompt,
  passwordRequiredMessage,
  readPassword,
  readPasswordFromPrompt,
  readPasswordViaStdin,
} from '#/db/seeders/read-password'
import { describe, expect, it, vi } from 'vitest'

describe('readPassword', () => {
  it('TTY ありでは対話入力を使う', async () => {
    const promptPassword = vi.fn().mockResolvedValue('secret-password')
    const readPasswordFromStdin = vi.fn()

    await expect(
      readPassword({
        input: { isTTY: true } as NodeJS.ReadStream,
        promptPassword,
        readPasswordFromStdin,
      })
    ).resolves.toBe('secret-password')

    expect(promptPassword).toHaveBeenCalledOnce()
    expect(readPasswordFromStdin).not.toHaveBeenCalled()
  })

  it('TTY なしでは stdin を使う', async () => {
    const promptPassword = vi.fn()
    const readPasswordFromStdin = vi.fn().mockResolvedValue('secret-password')

    await expect(
      readPassword({
        input: { isTTY: false } as NodeJS.ReadStream,
        promptPassword,
        readPasswordFromStdin,
      })
    ).resolves.toBe('secret-password')

    expect(readPasswordFromStdin).toHaveBeenCalledOnce()
    expect(promptPassword).not.toHaveBeenCalled()
  })
})

describe('readPasswordFromPrompt', () => {
  it('入力後に改行だけを出力し、平文は出力しない', async () => {
    const input = new PassThrough()
    Object.assign(input, { isTTY: true })
    const output = new CaptureWritable()

    const promise = readPasswordFromPrompt({
      input,
      output,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    input.end('secret-password\n')

    await expect(promise).resolves.toBe('secret-password')
    expect(output.value).toContain(passwordPrompt)
    expect(output.value).not.toContain('secret-password')
    expect(output.value.endsWith('\n')).toBe(true)
  })
})

describe('readPasswordViaStdin', () => {
  it('stdin から受け取ったパスワードを返す', async () => {
    const input = new PassThrough()
    input.end('secret-password\n')

    await expect(readPasswordViaStdin(input)).resolves.toBe('secret-password')
  })

  it('空入力の場合は失敗する', async () => {
    const input = new PassThrough()
    input.end('\n')

    await expect(readPasswordViaStdin(input)).rejects.toThrow(passwordRequiredMessage)
  })
})

class CaptureWritable extends Writable {
  value = ''

  override _write(chunk: Buffer | string, _: BufferEncoding, callback: (error?: Error | null) => void) {
    this.value += chunk.toString()
    callback()
  }
}
