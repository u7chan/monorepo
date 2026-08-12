// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'

const useChatSettingsContextMock = vi.hoisted(() => vi.fn())

vi.mock('#/client/features/chat/components/chat-settings/chat-settings-context', () => ({
  useChatSettingsContext: useChatSettingsContextMock,
}))

vi.mock('#/client/features/chat/components/chat-settings/model-selector', () => ({
  ModelSelector: () => null,
}))

vi.mock('#/client/features/chat/components/chat-settings/settings/auto-model-toggle', () => ({
  AutoModelToggle: () => null,
}))

vi.mock('#/client/features/chat/components/chat-settings/settings/reasoning-effort', () => ({
  ReasoningEffort: () => null,
}))

vi.mock('#/client/features/chat/components/chat-settings/settings/temperature-slider', () => ({
  TemperatureSlider: () => null,
}))

const settings: Settings = {
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
}

describe('ChatSettingsForm', () => {
  beforeEach(() => {
    useChatSettingsContextMock.mockReturnValue({
      settings,
      apiMode: settings.apiMode,
      fakeMode: settings.fakeMode,
      markdownPreview: settings.markdownPreview,
      streamMode: settings.streamMode,
      includeChatHistory: settings.includeChatHistory,
      sendImagesOnlyOnce: settings.sendImagesOnlyOnce,
      handleChangeBaseURL: vi.fn(),
      handleChangeApiKey: vi.fn(),
      handleChangeApiMode: vi.fn(),
      handleChangeMaxTokens: vi.fn(),
      handleToggleFakeMode: vi.fn(),
      handleToggleMarkdownPreview: vi.fn(),
      handleToggleStreamMode: vi.fn(),
      handleToggleIncludeChatHistory: vi.fn(),
      handleToggleSendImagesOnlyOnce: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('空の baseURL は既定 URL に置き換えず、設定エラーをパネル内に表示する', async () => {
    const { ChatSettingsForm } = await import('#/client/features/chat/components/chat-settings/chat-settings-form')
    const { container } = render(
      <ChatSettingsForm
        settingsError={{
          code: 'VALIDATION_ERROR',
          message: 'Base URL と API Key を設定してください。',
          retryable: false,
        }}
      />
    )

    const baseUrlInput = container.querySelector<HTMLInputElement>("input[name='baseURL']")
    expect(baseUrlInput?.value).toBe('')
    expect(baseUrlInput?.placeholder).not.toContain('api.openai.com')
    expect(screen.getByRole('alert').textContent).toBe('Base URL と API Key を設定してください。')
  })
})
