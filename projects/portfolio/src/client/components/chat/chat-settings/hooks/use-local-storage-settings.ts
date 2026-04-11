import { readFromLocalStorage, type Settings, saveToLocalStorage } from '#/client/storage/remote-storage-settings'
import { type Dispatch, type SetStateAction, useCallback, useMemo, useState } from 'react'

type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

interface UseLocalStorageSettingsOptions {
  onChange?: (settings: Settings) => void
}

interface UseLocalStorageSettingsReturn {
  settings: Settings
  model: string
  temperature: number
  temperatureEnabled: boolean
  autoModel: boolean
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  reasoningEffort: ReasoningEffortLevel
  reasoningEffortEnabled: boolean
  setModel: Dispatch<SetStateAction<string>>
  setTemperature: Dispatch<SetStateAction<number>>
  setTemperatureEnabled: Dispatch<SetStateAction<boolean>>
  setAutoModel: Dispatch<SetStateAction<boolean>>
  setFakeMode: Dispatch<SetStateAction<boolean>>
  setMarkdownPreview: Dispatch<SetStateAction<boolean>>
  setStreamMode: Dispatch<SetStateAction<boolean>>
  setInteractiveMode: Dispatch<SetStateAction<boolean>>
  setReasoningEffort: Dispatch<SetStateAction<ReasoningEffortLevel>>
  setReasoningEffortEnabled: Dispatch<SetStateAction<boolean>>
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Settings
}

export function useLocalStorageSettings(options: UseLocalStorageSettingsOptions = {}): UseLocalStorageSettingsReturn {
  const { onChange } = options

  const defaultSettings = useMemo(() => readFromLocalStorage(), [])

  const [model, setModel] = useState(defaultSettings.model)
  const [temperature, setTemperature] = useState<number>(defaultSettings.temperature)
  const [temperatureEnabled, setTemperatureEnabled] = useState(defaultSettings?.temperatureEnabled ?? false)
  const [autoModel, setAutoModel] = useState(defaultSettings?.autoModel ?? false)
  const [fakeMode, setFakeMode] = useState(defaultSettings?.fakeMode ?? false)
  const [markdownPreview, setMarkdownPreview] = useState(defaultSettings?.markdownPreview ?? true)
  const [streamMode, setStreamMode] = useState(defaultSettings?.streamMode ?? true)
  const [interactiveMode, setInteractiveMode] = useState(defaultSettings?.interactiveMode ?? true)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortLevel>(
    defaultSettings?.reasoningEffort ?? 'medium'
  )
  const [reasoningEffortEnabled, setReasoningEffortEnabled] = useState(defaultSettings?.reasoningEffortEnabled ?? false)

  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      const settings = saveToLocalStorage({ [key]: value })
      onChange?.(settings)
      return settings
    },
    [onChange]
  )

  const settings = useMemo(() => ({ ...defaultSettings, model }), [defaultSettings, model])

  return {
    settings,
    model,
    temperature,
    temperatureEnabled,
    autoModel,
    fakeMode,
    markdownPreview,
    streamMode,
    interactiveMode,
    reasoningEffort,
    reasoningEffortEnabled,
    setModel,
    setTemperature,
    setTemperatureEnabled,
    setAutoModel,
    setFakeMode,
    setMarkdownPreview,
    setStreamMode,
    setInteractiveMode,
    setReasoningEffort,
    setReasoningEffortEnabled,
    updateSetting,
  }
}
