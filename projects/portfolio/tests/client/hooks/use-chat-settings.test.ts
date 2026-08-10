// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'

const STORAGE_KEY = 'portfolio.chat-settings'

const useModelFetchingMock = vi.hoisted(() => vi.fn())

vi.mock('#/client/features/chat/components/chat-settings/hooks/use-model-fetching', () => ({
  useModelFetching: useModelFetchingMock,
}))

vi.mock('#/client/shared/hooks/use-lock-body-scroll', () => ({
  useLockBodyScroll: vi.fn(),
}))

const createLocalStorageMock = (initialEntries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initialEntries))

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

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
  includeChatHistory: false,
  sendImagesOnlyOnce: true,
  imageGenerationMode: true,
  sidebarOpen: true,
  templateModels: {},
}

describe('useChatSettings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock({ [STORAGE_KEY]: JSON.stringify(settings) }))
    useModelFetchingMock.mockReturnValue({
      fetchedModels: [],
      isLoadingModels: false,
      fetchError: null,
      refetchModels: vi.fn(),
    })
    vi.resetModules()
  })

  it('ページの共有設定更新を同一画面の通常設定値へ反映する', async () => {
    const { useChatSettings } = await import('#/client/features/chat/components/chat-settings/hooks/use-chat-settings')
    const { result, rerender } = renderHook(
      ({ currentSettings }: { currentSettings: Settings }) => useChatSettings({ settings: currentSettings }),
      { initialProps: { currentSettings: settings } }
    )

    expect(result.current.includeChatHistory).toBe(false)

    rerender({ currentSettings: { ...settings, includeChatHistory: true } })

    expect(result.current.includeChatHistory).toBe(true)
    expect(result.current.settings.includeChatHistory).toBe(true)
  })

  it('設定パネル側の履歴 toggle も共有設定を更新して永続化する', async () => {
    const { useChatSettings } = await import('#/client/features/chat/components/chat-settings/hooks/use-chat-settings')
    const { result } = renderHook(() => {
      const [currentSettings, setCurrentSettings] = useState(settings)
      const context = useChatSettings({ settings: currentSettings, onChange: setCurrentSettings })
      return { context }
    })

    act(() => {
      result.current.context.handleToggleIncludeChatHistory()
    })

    expect(result.current.context.includeChatHistory).toBe(true)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ includeChatHistory: true })
  })
})
