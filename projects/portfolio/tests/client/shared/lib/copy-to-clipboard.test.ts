// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from '#/client/shared/lib/copy-to-clipboard'

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Clipboard APIが利用できる場合はwriteTextを使う', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await copyToClipboard('message dump')

    expect(writeText).toHaveBeenCalledWith('message dump')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('Clipboard APIが利用できない場合はexecCommandの成功を確認する', async () => {
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await copyToClipboard('message dump')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('execCommandがfalseを返した場合は失敗し、textareaを削除する', async () => {
    const execCommand = vi.fn().mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await expect(copyToClipboard('message dump')).rejects.toThrow('Failed to copy text to clipboard')

    expect(document.querySelector('textarea')).toBeNull()
  })

  it('execCommandがthrowした場合もtextareaを削除する', async () => {
    const error = new Error('copy command failed')
    const execCommand = vi.fn().mockImplementation(() => {
      throw error
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await expect(copyToClipboard('message dump')).rejects.toBe(error)

    expect(document.querySelector('textarea')).toBeNull()
  })
})
