// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('crypto-js', () => ({
  default: {
    AES: {
      encrypt: (value: string) => ({ toString: () => value }),
      decrypt: (value: string) => ({ toString: () => value }),
    },
    enc: { Utf8: 'utf8' },
  },
}))

const STORAGE_KEY = 'portfolio.chat-settings'

const defaultSettings = {
  schemaVersion: '1.0.0',
  model: 'gpt-4.1-mini',
  baseURL: '',
  apiKey: '',
  mcpServerURLs: '',
  temperature: 0.7,
  temperatureEnabled: false,
  maxTokens: undefined,
  reasoningEffort: 'medium',
  reasoningEffortEnabled: false,
  fakeMode: false,
  autoModel: false,
  markdownPreview: true,
  streamMode: true,
  interactiveMode: true,
  templateModels: {},
}

describe('useSettingsHandlers', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultSettings))
    vi.resetModules()
  })

  const importHooks = async () => {
    const { useLocalStorageSettings } =
      await import('#/client/components/chat/chat-settings/hooks/use-local-storage-settings')
    const { useSettingsHandlers } = await import('#/client/components/chat/chat-settings/hooks/use-settings-handlers')
    return { useLocalStorageSettings, useSettingsHandlers }
  }

  const createChangeEvent = <T extends string>(value: T) =>
    ({ target: { value } }) as unknown as React.ChangeEvent<HTMLInputElement & HTMLSelectElement>

  describe('toggle ハンドラ', () => {
    it('handleToggleFakeMode が状態を反転して localStorage に保存する', async () => {
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings()
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      expect(result.current.storage.fakeMode).toBe(false)

      act(() => {
        result.current.handlers.handleToggleFakeMode()
      })

      expect(result.current.storage.fakeMode).toBe(true)
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.fakeMode).toBe(true)
    })

    it('handleToggleStreamMode が状態を反転して localStorage に保存する', async () => {
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings()
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      expect(result.current.storage.streamMode).toBe(true)

      act(() => {
        result.current.handlers.handleToggleStreamMode()
      })

      expect(result.current.storage.streamMode).toBe(false)
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.streamMode).toBe(false)
    })

    it('handleToggleTemperature が状態を反転して localStorage に保存する', async () => {
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings()
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      expect(result.current.storage.temperatureEnabled).toBe(false)

      act(() => {
        result.current.handlers.handleToggleTemperature()
      })

      expect(result.current.storage.temperatureEnabled).toBe(true)
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.temperatureEnabled).toBe(true)
    })
  })

  describe('変更ハンドラ', () => {
    it('handleChangeAutoModel が model を更新して localStorage に保存する', async () => {
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings()
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      act(() => {
        result.current.handlers.handleChangeAutoModel(createChangeEvent('gpt-4.1'))
      })

      expect(result.current.storage.model).toBe('gpt-4.1')
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.model).toBe('gpt-4.1')
    })

    it('handleChangeTemperature が temperature を更新して localStorage に保存する', async () => {
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings()
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      act(() => {
        result.current.handlers.handleChangeTemperature(createChangeEvent('1.5'))
      })

      expect(result.current.storage.temperature).toBe(1.5)
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.temperature).toBe(1.5)
    })

    it('handleChangeReasoningEffort が reasoningEffort を更新して localStorage に保存する', async () => {
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings()
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      act(() => {
        result.current.handlers.handleChangeReasoningEffort(createChangeEvent('high'))
      })

      expect(result.current.storage.reasoningEffort).toBe('high')
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.reasoningEffort).toBe('high')
    })
  })

  describe('onChange 連携', () => {
    it('toggle 操作で onChange コールバックが呼ばれる', async () => {
      const onChange = vi.fn()
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings({ onChange })
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      act(() => {
        result.current.handlers.handleToggleMarkdownPreview()
      })

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ markdownPreview: false }))
    })

    it('model 変更で onChange コールバックが呼ばれる', async () => {
      const onChange = vi.fn()
      const { useLocalStorageSettings, useSettingsHandlers } = await importHooks()

      const { result } = renderHook(() => {
        const storage = useLocalStorageSettings({ onChange })
        const handlers = useSettingsHandlers({
          ...storage,
          updateSetting: storage.updateSetting,
        })
        return { storage, handlers }
      })

      act(() => {
        result.current.handlers.handleChangeManualModel(createChangeEvent('custom-model'))
      })

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ model: 'custom-model' }))
    })
  })
})
