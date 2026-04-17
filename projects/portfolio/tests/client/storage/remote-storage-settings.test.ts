// @vitest-environment jsdom

import crypto from 'crypto-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const LEGACY_SETTINGS_AES_KEY = '3f1a9c7e5d4b8f012367a9c4e2d5b7f0'
const STORAGE_KEY = 'portfolio.chat-settings'

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

describe('remote-storage-settings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock())
    vi.resetModules()
  })

  it('localStorage が空ならデフォルト設定を返す', async () => {
    const { readFromLocalStorage } = await import('#/client/storage/remote-storage-settings')

    const settings = readFromLocalStorage()

    expect(settings).toEqual(
      expect.objectContaining({
        schemaVersion: '1.1.0',
        model: 'gpt-4.1-mini',
        apiKey: '',
      })
    )
  })

  it('1.0.x の暗号化 apiKey を 1 回だけ平文へ移行する', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: '1.0.0',
        model: 'gpt-4.1',
        baseURL: 'https://api.openai.com/v1',
        apiKey: crypto.AES.encrypt('secret-api-key', LEGACY_SETTINGS_AES_KEY).toString(),
        temperature: 0.7,
        temperatureEnabled: false,
        reasoningEffort: 'medium',
        reasoningEffortEnabled: false,
        fakeMode: false,
        autoModel: false,
        markdownPreview: true,
        streamMode: true,
        interactiveMode: true,
        templateModels: {},
      })
    )

    const { readFromLocalStorage } = await import('#/client/storage/remote-storage-settings')
    const settings = readFromLocalStorage()
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')

    expect(settings.schemaVersion).toBe('1.1.0')
    expect(settings.apiKey).toBe('secret-api-key')
    expect(stored.apiKey).toBe('secret-api-key')
    expect(stored.schemaVersion).toBe('1.1.0')
  })

  it('壊れた legacy apiKey は空文字にして他設定を維持する', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: '1.0.0',
        model: 'gpt-4.1',
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'U2FsdGVkX1broken',
        temperature: 0.3,
        temperatureEnabled: true,
        reasoningEffort: 'high',
        reasoningEffortEnabled: true,
        fakeMode: false,
        autoModel: true,
        markdownPreview: false,
        streamMode: false,
        interactiveMode: false,
        templateModels: {},
      })
    )

    const { readFromLocalStorage } = await import('#/client/storage/remote-storage-settings')
    const settings = readFromLocalStorage()

    expect(settings.schemaVersion).toBe('1.1.0')
    expect(settings.apiKey).toBe('')
    expect(settings.model).toBe('gpt-4.1')
    expect(settings.temperature).toBe(0.3)
  })

  it('旧 localStorage に mcpServerURLs があっても読み込み後に除去される', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: '1.1.0',
        model: 'gpt-4.1-mini',
        apiKey: 'some-key',
        mcpServerURLs: 'http://localhost:3001',
      })
    )

    const { readFromLocalStorage } = await import('#/client/storage/remote-storage-settings')
    const settings = readFromLocalStorage()

    expect('mcpServerURLs' in settings).toBe(false)
  })
})
