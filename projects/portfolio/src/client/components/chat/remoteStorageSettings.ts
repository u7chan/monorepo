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

export function readFromLocalStorage(): Settings {
  const key = 'portfolio.chat-settings'
  const value = localStorage.getItem(key)
  return (value && JSON.parse(value)) || defaultSettings
}

export function saveToLocalStorage(settings: Partial<Settings>): Settings {
  const key = 'portfolio.chat-settings'
  const newSettings = { ...readFromLocalStorage(), ...settings }
  localStorage.setItem(key, JSON.stringify(newSettings))
  return readFromLocalStorage()
}
