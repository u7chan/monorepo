import { useCallback, useState } from 'react'
import type { ApiMode } from '#/types'

const STORAGE_KEY = 'portfolio.compare-settings'
const SCHEMA_VERSION = '1.0.0'

export interface CompareSettings {
  schemaVersion: string
  baseURL: string
  apiKey: string
  apiMode: ApiMode
}

const defaultSettings: CompareSettings = {
  schemaVersion: SCHEMA_VERSION,
  baseURL: '',
  apiKey: '',
  apiMode: 'chat_completions',
}

function readFromLocalStorage(): CompareSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return defaultSettings
    const parsed = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return defaultSettings
    return {
      schemaVersion: typeof parsed.schemaVersion === 'string' ? parsed.schemaVersion : SCHEMA_VERSION,
      baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL : defaultSettings.baseURL,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : defaultSettings.apiKey,
      apiMode:
        parsed.apiMode === 'chat_completions' || parsed.apiMode === 'responses'
          ? parsed.apiMode
          : defaultSettings.apiMode,
    }
  } catch {
    return defaultSettings
  }
}

function writeToLocalStorage(settings: CompareSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, schemaVersion: SCHEMA_VERSION }))
}

export function useCompareSettings() {
  const [settings, setSettings] = useState<CompareSettings>(() => readFromLocalStorage())

  const updateSettings = useCallback((next: CompareSettings) => {
    const normalized = { ...next, schemaVersion: SCHEMA_VERSION }
    writeToLocalStorage(normalized)
    setSettings(normalized)
  }, [])

  return { settings, updateSettings }
}
