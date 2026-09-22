// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'

const useChatSettingsContextMock = vi.hoisted(() => vi.fn())
const handleChangeApiModeMock = vi.hoisted(() => vi.fn())
const handleChangeImageGenerationModelMock = vi.hoisted(() => vi.fn())
const refetchImageModelsMock = vi.hoisted(() => vi.fn())

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
  schemaVersion: '1.5.0',
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
  imageGenerationModel: '',
  imageGenerationBaseURL: '',
  imageGenerationApiKey: '',
  sidebarOpen: true,
  templateModels: {},
}

const createContextValue = () => ({
  settings,
  apiMode: settings.apiMode,
  fakeMode: settings.fakeMode,
  markdownPreview: settings.markdownPreview,
  streamMode: settings.streamMode,
  includeChatHistory: settings.includeChatHistory,
  sendImagesOnlyOnce: settings.sendImagesOnlyOnce,
  imageModels: ['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst'],
  isLoadingImageModels: false,
  imageModelsError: null,
  refetchImageModels: refetchImageModelsMock,
  resolvedImageGenerationModel: 'openai/gpt-image-2.5-flare',
  handleChangeBaseURL: vi.fn(),
  handleChangeApiKey: vi.fn(),
  handleChangeApiMode: handleChangeApiModeMock,
  handleChangeMaxTokens: vi.fn(),
  handleChangeImageGenerationModel: handleChangeImageGenerationModelMock,
  handleChangeImageGenerationBaseURL: vi.fn(),
  handleChangeImageGenerationApiKey: vi.fn(),
  handleToggleFakeMode: vi.fn(),
  handleToggleMarkdownPreview: vi.fn(),
  handleToggleStreamMode: vi.fn(),
  handleToggleIncludeChatHistory: vi.fn(),
  handleToggleSendImagesOnlyOnce: vi.fn(),
})

describe('ChatSettingsForm', () => {
  beforeEach(() => {
    useChatSettingsContextMock.mockReturnValue(createContextValue())
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  describe('設定エラー', () => {
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

  describe('タブ', () => {
    it('画像生成モードでは画像生成タブを既定で開く', async () => {
      const { ChatSettingsForm } = await import('#/client/features/chat/components/chat-settings/chat-settings-form')
      render(<ChatSettingsForm imageGenerationMode />)

      expect(screen.getByRole('tab', { name: '画像生成' }).getAttribute('aria-selected')).toBe('true')
      expect(screen.getByRole('heading', { name: 'Image Generation' })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Model' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Parameters' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Display Options' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Debug Options' })).toBeNull()
      expect(screen.getByRole('heading', { name: 'API Configuration' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Context Options' })).toBeTruthy()
      expect(screen.getByText('Include chat history')).toBeTruthy()
      expect(screen.queryByText('Send attached images only once')).toBeNull()
    })

    it('タブを切り替えると通常の設定を表示する', async () => {
      const { ChatSettingsForm } = await import('#/client/features/chat/components/chat-settings/chat-settings-form')
      render(<ChatSettingsForm imageGenerationMode />)

      fireEvent.click(screen.getByRole('tab', { name: 'チャット' }))

      expect(screen.getByRole('heading', { name: 'Model' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Parameters' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Debug Options' })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Image Generation' })).toBeNull()
    })
  })

  describe('通常対話の設定', () => {
    it('全セクションとContext Optionsの項目を表示する', async () => {
      const { ChatSettingsForm } = await import('#/client/features/chat/components/chat-settings/chat-settings-form')
      render(<ChatSettingsForm />)

      expect(screen.getByRole('heading', { name: 'Model' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'API Configuration' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Parameters' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Display Options' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Context Options' })).toBeTruthy()
      expect(screen.getByText('Include chat history')).toBeTruthy()
      expect(screen.getByText('Send attached images only once')).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Debug Options' })).toBeTruthy()
      const apiModeSelect = screen.getByRole('combobox') as HTMLSelectElement
      expect(apiModeSelect.value).toBe('chat_completions')

      fireEvent.change(apiModeSelect, { target: { value: 'responses' } })
      expect(handleChangeApiModeMock).toHaveBeenCalled()
    })
  })

  describe('画像生成の設定', () => {
    it('解決済みの画像モデルを初期値にして、変更を保存ハンドラへ渡す', async () => {
      const { ChatSettingsForm } = await import('#/client/features/chat/components/chat-settings/chat-settings-form')
      render(<ChatSettingsForm imageGenerationMode />)

      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select.value).toBe('openai/gpt-image-2.5-flare')

      fireEvent.change(select, { target: { value: 'openai/gpt-image-2.5-sunburst' } })

      expect(handleChangeImageGenerationModelMock).toHaveBeenCalled()
    })

    it('画像モデルを取得できないときは再読み込みを促す', async () => {
      useChatSettingsContextMock.mockReturnValue({
        ...createContextValue(),
        imageModels: [],
        resolvedImageGenerationModel: null,
      })
      const { ChatSettingsForm } = await import('#/client/features/chat/components/chat-settings/chat-settings-form')
      render(<ChatSettingsForm imageGenerationMode />)

      expect(
        screen.getByText('画像生成モデルを取得できませんでした。Base URL と API Key を確認してください。')
      ).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: '再読み込み' }))

      expect(refetchImageModelsMock).toHaveBeenCalled()
    })

    it('画像生成用の Base URL と API Key の上書きを入力できる', async () => {
      const { ChatSettingsForm } = await import('#/client/features/chat/components/chat-settings/chat-settings-form')
      const { container } = render(<ChatSettingsForm imageGenerationMode />)

      expect(container.querySelector("input[name='imageGenerationBaseURL']")).toBeTruthy()
      expect(container.querySelector("input[name='imageGenerationApiKey']")).toBeTruthy()
    })
  })
})
