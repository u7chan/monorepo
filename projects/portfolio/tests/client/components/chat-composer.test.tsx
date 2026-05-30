// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer } from '#/client/features/chat/components/chat-composer'

vi.mock('#/client/shared/components/input/file-image-input', () => ({
  FileImageInput: ({ fileInputButton }: { fileInputButton: (onClick: () => void) => React.ReactNode }) => (
    <div data-testid='file-image-input'>{fileInputButton(vi.fn())}</div>
  ),
  FileImagePreview: ({ children }: { children: React.ReactNode }) => (
    <div data-testid='file-image-preview'>{children}</div>
  ),
}))

const defaultProps = {
  value: '',
  textAreaRows: 2,
  placeholder: '質問してみよう！',
  loading: false,
  streamActive: false,
  includeChatHistory: true,
  sendImagesOnlyOnce: true,
  uploadImages: [],
  onCancelStream: vi.fn(),
  onImageChange: vi.fn(),
  onChangeInput: vi.fn(),
  onKeyDown: vi.fn(),
  onChangeComposition: vi.fn(),
}

describe('ChatComposer', () => {
  afterEach(() => {
    cleanup()
  })

  it('入力が空のとき送信ボタンを無効にし、画像アップロードを表示する', () => {
    render(<ChatComposer {...defaultProps} />)

    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(buttons.at(-1)?.disabled).toBe(true)
    expect(screen.getByText('画像アップロード')).toBeTruthy()
  })

  it('loading 中は停止ボタンを表示する', () => {
    render(<ChatComposer {...defaultProps} value='hello' loading={true} />)

    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(buttons.at(-1)?.disabled).toBe(false)
    expect(screen.getByRole('textbox')).toBeTruthy()
  })
})
