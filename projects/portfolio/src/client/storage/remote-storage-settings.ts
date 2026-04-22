import { ApiModeSchema, type ApiMode } from '#/types'
import { decryptLegacyApiKey } from './legacy-remote-storage'

const STORAGE_KEY = 'portfolio.chat-settings'
const SCHEMA_VERSION = '1.2.0'

export interface Settings {
  schemaVersion: string
  model: string
  baseURL: string
  apiKey: string
  apiMode: ApiMode
  temperature: number
  temperatureEnabled: boolean
  maxTokens?: number
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  reasoningEffortEnabled: boolean
  fakeMode: boolean
  autoModel: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  sidebarOpen: boolean
  templateModels: {
    [key: string]: {
      model: string
    }
  }
}

type StoredSettings = Partial<Settings> & {
  schemaVersion?: string
}

const defaultSettings: Settings = {
  schemaVersion: SCHEMA_VERSION,
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
  interactiveMode: true,
  sidebarOpen: true,
  templateModels: {},
}

export function readFromLocalStorage(): Settings {
  const settings = parseStoredSettings(localStorage.getItem(STORAGE_KEY))

  if (!settings) {
    return defaultSettings
  }

  if (isLegacySettings(settings)) {
    const migratedSettings = migrateLegacySettings(settings)
    writeToLocalStorage(migratedSettings)
    return migratedSettings
  }

  if (!isCompatibleSchema(settings.schemaVersion)) {
    return defaultSettings
  }

  const normalizedSettings = mergeSettings(settings)

  if (shouldPersistNormalizedSettings(settings, normalizedSettings)) {
    writeToLocalStorage(normalizedSettings)
  }

  return normalizedSettings
}

export function saveToLocalStorage(settings: Partial<Settings>): Settings {
  const nextSettings = mergeSettings({
    ...readFromLocalStorage(),
    ...settings,
    schemaVersion: SCHEMA_VERSION,
  })

  writeToLocalStorage(nextSettings)
  return nextSettings
}

function parseStoredSettings(value: string | null): StoredSettings | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? (parsed as StoredSettings) : null
  } catch {
    return null
  }
}

function mergeSettings(settings: Partial<Settings> & { mcpServerURLs?: unknown }): Settings {
  const { mcpServerURLs: _dropped, ...rest } = settings
  const apiMode = normalizeApiMode(rest.apiMode)

  return {
    ...defaultSettings,
    ...rest,
    apiMode,
    fakeMode: apiMode === 'responses' ? false : (rest.fakeMode ?? defaultSettings.fakeMode),
    schemaVersion: SCHEMA_VERSION,
  }
}

function writeToLocalStorage(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

function isCompatibleSchema(schemaVersion: string | undefined): boolean {
  return schemaVersion?.split('.')[0] === SCHEMA_VERSION.split('.')[0]
}

function isLegacySettings(settings: StoredSettings): boolean {
  return settings.schemaVersion?.startsWith('1.0.') ?? false
}

function migrateLegacySettings(settings: StoredSettings): Settings {
  const apiKey = typeof settings.apiKey === 'string' ? (decryptLegacyApiKey(settings.apiKey) ?? '') : ''

  return mergeSettings({
    ...settings,
    apiKey,
    schemaVersion: SCHEMA_VERSION,
  })
}

function normalizeApiMode(value: unknown): ApiMode {
  const parsed = ApiModeSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultSettings.apiMode
}

function shouldPersistNormalizedSettings(
  settings: StoredSettings & { mcpServerURLs?: unknown },
  normalized: Settings
): boolean {
  return (
    settings.schemaVersion !== SCHEMA_VERSION ||
    !ApiModeSchema.safeParse(settings.apiMode).success ||
    (normalized.apiMode === 'responses' && settings.fakeMode === true) ||
    'mcpServerURLs' in settings
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
