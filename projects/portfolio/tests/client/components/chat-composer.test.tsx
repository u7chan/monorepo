// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
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

  it('画像生成モード時は下部の On バッジを表示する', () => {
    render(<ChatComposer {...defaultProps} imageGenerationMode={true} />)

    expect(screen.getByRole('button', { name: '画像生成モード On/Off' }).textContent).toContain('画像生成 On')
  })

  it('画像モードの履歴バッジは共有 Include chat history の値を表示・更新する', () => {
    function ComposerWithSharedHistory() {
      const [includeChatHistory, setIncludeChatHistory] = useState(false)

      return (
        <ChatComposer
          {...defaultProps}
          imageGenerationMode={true}
          includeChatHistory={includeChatHistory}
          onToggleChatHistory={() => setIncludeChatHistory((current) => !current)}
        />
      )
    }

    render(<ComposerWithSharedHistory />)

    const historyButton = screen.getByRole('button', { name: '画像生成 prompt 履歴 On/Off' })
    expect(historyButton.textContent).toContain('履歴 Off')

    fireEvent.click(historyButton)

    expect(historyButton.textContent).toContain('履歴 On')
  })
})
