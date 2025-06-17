import crypto from 'crypto-js'

export interface Settings {
  model: string
  baseURL: string
  apiKey: string
  mcpServerURLs: string
  temperature: number
  temperatureEnabled: boolean
  maxTokens?: number
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  templateModels: {
    [key: string]: {
      model: string
    }
  }
}

const defaultSettings: Settings = {
  model: 'gpt-4.1-mini',
  baseURL: '',
  apiKey: '',
  mcpServerURLs: '',
  temperature: 0.7,
  temperatureEnabled: false,
  maxTokens: undefined,
  fakeMode: false,
  markdownPreview: true,
  streamMode: true,
  interactiveMode: true,
  templateModels: {},
}

const AES_KEY = '3f1a9c7e5d4b8f012367a9c4e2d5b7f0'

export function readFromLocalStorage(): Settings {
  const key = 'portfolio.chat-settings'
  const value = localStorage.getItem(key)
  const settings = (value && JSON.parse(value)) || defaultSettings
  return {
    ...settings,
    apiKey: crypto.AES.decrypt(settings.apiKey, AES_KEY).toString(crypto.enc.Utf8),
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
