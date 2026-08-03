// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from '#/client/shared/lib/copy-to-clipboard'

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Clipboard APIが利用できない場合もテキストをコピーする', async () => {
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await copyToClipboard('message dump')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
