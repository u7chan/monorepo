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

describe('useLocalStorageSettings', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  const importHook = async () => {
    const mod = await import('#/client/components/chat/chat-settings/hooks/use-local-storage-settings')
    return mod.useLocalStorageSettings
  }

  describe('初期化', () => {
    it('localStorage が空のときデフォルト設定を返す', async () => {
      const useLocalStorageSettings = await importHook()
      const { result } = renderHook(() => useLocalStorageSettings())

      expect(result.current.model).toBe('gpt-4.1-mini')
      expect(result.current.temperature).toBe(0.7)
      expect(result.current.temperatureEnabled).toBe(false)
      expect(result.current.autoModel).toBe(false)
      expect(result.current.streamMode).toBe(true)
    })

    it('localStorage に保存済みの設定を復元する', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...defaultSettings, model: 'gpt-4.1', temperature: 0.3, fakeMode: true })
      )

      const useLocalStorageSettings = await importHook()
      const { result } = renderHook(() => useLocalStorageSettings())

      expect(result.current.model).toBe('gpt-4.1')
      expect(result.current.temperature).toBe(0.3)
      expect(result.current.fakeMode).toBe(true)
    })
  })

  describe('updateSetting', () => {
    it('localStorage に保存して onChange を呼ぶ', async () => {
      const onChange = vi.fn()
      const useLocalStorageSettings = await importHook()
      const { result } = renderHook(() => useLocalStorageSettings({ onChange }))

      act(() => {
        result.current.updateSetting('model', 'gpt-4.1')
      })

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.model).toBe('gpt-4.1')
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4.1' }))
    })

    it('temperature を更新して永続化する', async () => {
      const onChange = vi.fn()
      const useLocalStorageSettings = await importHook()
      const { result } = renderHook(() => useLocalStorageSettings({ onChange }))

      act(() => {
        result.current.updateSetting('temperature', 1.2)
      })

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.temperature).toBe(1.2)
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ temperature: 1.2 }))
    })
  })
})
