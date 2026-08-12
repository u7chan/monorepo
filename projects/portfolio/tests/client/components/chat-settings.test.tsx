// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'

const useChatSettingsMock = vi.hoisted(() => vi.fn())

const settings = {
  schemaVersion: '1.4.0',
  model: 'gpt-4.1-mini',
  baseURL: '',
  apiKey: '',
  apiMode: 'chat_completions',
  temperature: 0.7,
  temperatureEnabled: false,
  maxTokens: undefined,
  reasoningEffort: 'medium',
  reasoningEffortEnabled: false,
  fakeMode: false,
  autoModel: false,
  markdownPreview: true,
  streamMode: true,
  includeChatHistory: true,
  sendImagesOnlyOnce: true,
  imageGenerationMode: true,
  sidebarOpen: true,
  templateModels: {},
} satisfies Settings

vi.mock('#/client/features/chat/components/chat-settings/hooks/use-chat-settings', () => ({
  useChatSettings: useChatSettingsMock,
}))

vi.mock('#/client/features/chat/components/chat-settings/chat-settings-form', () => ({
  ChatSettingsForm: ({ imageGenerationMode }: { imageGenerationMode?: boolean }) => (
    <div data-testid='settings-form' data-image-generation-mode={String(!!imageGenerationMode)} />
  ),
}))

vi.mock('#/client/features/chat/components/chat-settings/chat-settings-panel', () => ({
  ChatSettingsPanel: ({ children, show }: { children: ReactNode; show: boolean }) => (
    <div data-testid='settings-panel' data-show={show}>
      {children}
    </div>
  ),
}))

import { ChatSettings } from '#/client/features/chat/components/chat-settings/chat-settings'

describe('ChatSettings', () => {
  beforeEach(() => {
    useChatSettingsMock.mockReturnValue({
      fakeMode: false,
      settings: { model: 'gpt-4.1-mini' },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('画像生成モード時は右上に固定モデル名を表示する', () => {
    render(
      <ChatSettings
        settings={settings}
        showActions={true}
        showNewChat={false}
        showSidebarToggle={false}
        imageGenerationMode={true}
      />
    )

    expect(screen.getByText('gpt-image-2')).toBeTruthy()
    expect(screen.queryByText('画像生成モード')).toBeNull()
  })

  it('画像生成モード時も Settings ボタンから既存パネルを開ける', () => {
    render(
      <ChatSettings
        settings={settings}
        showActions={true}
        showPopup={true}
        showNewChat={false}
        showSidebarToggle={false}
        imageGenerationMode={true}
      />
    )

    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByTestId('settings-panel').dataset.show).toBe('true')
    expect(screen.getByTestId('settings-form').dataset.imageGenerationMode).toBe('true')
  })
})
