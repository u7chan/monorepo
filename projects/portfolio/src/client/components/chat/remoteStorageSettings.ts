type Settings = {
  model: string
  baseURL: string
  apiKey: string
  mcpServerURLs: string
  temperature: string
  temperatureEnabled: boolean
  maxTokens: string
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

export function readFromLocalStorage(): Partial<Settings> {
  const key = 'portfolio.chat-settings'
  return JSON.parse(localStorage.getItem(key) || '{}')
}

export function saveToLocalStorage(settings: Partial<Settings>) {
  const key = 'portfolio.chat-settings'
  const newSettings = { ...readFromLocalStorage(), ...settings }
  localStorage.setItem(key, JSON.stringify(newSettings))
}
