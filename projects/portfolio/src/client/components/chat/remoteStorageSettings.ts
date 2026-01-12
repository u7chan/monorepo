import crypto from 'crypto-js'

const SCHEMA_VERSION = '1.0.0'
const AES_KEY = '3f1a9c7e5d4b8f012367a9c4e2d5b7f0'

export interface Settings {
  schemaVersion: string
  model: string
  baseURL: string
  apiKey: string
  mcpServerURLs: string
  temperature: number
  temperatureEnabled: boolean
  maxTokens?: number
  fakeMode: boolean
  autoModel: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  templateModels: {
    [key: string]: {
      model: string
    }
  }
}

const defaultSettings: Partial<Settings> = {
  schemaVersion: SCHEMA_VERSION,
  model: 'gpt-4.1-mini',
  baseURL: '',
  apiKey: '',
  mcpServerURLs: '',
  temperature: 0.7,
  temperatureEnabled: false,
  maxTokens: undefined,
  fakeMode: false,
  autoModel: false,
  markdownPreview: true,
  streamMode: true,
  interactiveMode: true,
  templateModels: {},
}

export function readFromLocalStorage(): Settings {
  const key = 'portfolio.chat-settings'
  const value = localStorage.getItem(key)
  const settings = (value && JSON.parse(value)) || defaultSettings

  // SCHEMA_VERSIONのメジャーバージョンチェック
  const currentMajorVersion = SCHEMA_VERSION.split('.')[0]
  const settingsMajorVersion = settings.schemaVersion?.split('.')[0]

  // schemaVersionが空文字、undefined、または異なるメジャーバージョンの場合はdefaultSettingsで上書き
  const finalSettings =
    !settings.schemaVersion || !settingsMajorVersion || settingsMajorVersion !== currentMajorVersion
      ? defaultSettings
      : settings

  return {
    ...finalSettings,
    apiKey: crypto.AES.decrypt(finalSettings.apiKey, AES_KEY).toString(crypto.enc.Utf8),
  }
}

export function saveToLocalStorage(settings: Partial<Settings>): Settings {
  const key = 'portfolio.chat-settings'
  const newSettings = { ...readFromLocalStorage(), ...settings }
  localStorage.setItem(
    key,
    JSON.stringify({
      ...newSettings,
      apiKey: crypto.AES.encrypt(newSettings.apiKey, AES_KEY).toString(),
    }),
  )
  return readFromLocalStorage()
}
