import { useLockBodyScroll } from '#/client/hooks/use-lock-body-scroll'
import { readFromLocalStorage, type Settings, saveToLocalStorage } from '#/client/storage/remote-storage-settings'
import type { AppType } from '#/server/app'
import { hc } from 'hono/client'
import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

const client = hc<AppType>('/')

interface UseChatSettingsOptions {
  showPopup?: boolean
  onChange?: (settings: Settings) => void
}

interface UseChatSettingsReturn {
  settings: Settings
  fetchedModels: string[]
  temperature: number
  temperatureEnabled: boolean
  autoModel: boolean
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  reasoningEffortEnabled: boolean
  handleChangeAutoModel: (event: ChangeEvent<HTMLSelectElement>) => void
  handleChangeManualModel: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeBaseURL: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeApiKey: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeMcpServerURLs: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeTemperature: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeMaxTokens: (event: ChangeEvent<HTMLInputElement>) => void
  handleToggleTemperature: () => void
  handleToggleAutoModel: () => void
  handleToggleFakeMode: () => void
  handleToggleMarkdownPreview: () => void
  handleToggleStreamMode: () => void
  handleToggleInteractiveMode: () => void
  handleToggleReasoningEffort: () => void
  handleChangeReasoningEffort: (event: ChangeEvent<HTMLSelectElement>) => void
}

async function fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const response = await client.api['fetch-models'].$get({
      header: {
        'api-key': apiKey,
        'base-url': baseURL,
      },
    })
    if (response.ok) {
      return await response.json()
    }
  } catch (error) {
    console.error('Failed to fetch models:', error)
  }
  return []
}

export function useChatSettings(options: UseChatSettingsOptions = {}): UseChatSettingsReturn {
  const { showPopup, onChange } = options

  // Lock body scroll when popup is open
  useLockBodyScroll(showPopup ?? false)

  const defaultSettings = useMemo(() => readFromLocalStorage(), [])

  const [model, setModel] = useState(defaultSettings.model)
  const [temperature, setTemperature] = useState<number>(defaultSettings.temperature)
  const [temperatureEnabled, setTemperatureEnabled] = useState(defaultSettings?.temperatureEnabled ?? false)
  const [autoModel, setAutoModel] = useState(defaultSettings?.autoModel ?? false)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [fakeMode, setFakeMode] = useState(defaultSettings?.fakeMode ?? false)
  const [markdownPreview, setMarkdownPreview] = useState(defaultSettings?.markdownPreview ?? true)
  const [streamMode, setStreamMode] = useState(defaultSettings?.streamMode ?? true)
  const [interactiveMode, setInteractiveMode] = useState(defaultSettings?.interactiveMode ?? true)
  const [reasoningEffort, setReasoningEffort] = useState<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>(
    defaultSettings?.reasoningEffort ?? 'medium'
  )
  const [reasoningEffortEnabled, setReasoningEffortEnabled] = useState(defaultSettings?.reasoningEffortEnabled ?? false)

  // Fetch models when autoModel is enabled
  useEffect(() => {
    if (autoModel) {
      const { baseURL, apiKey } = readFromLocalStorage()
      fetchModels(baseURL, apiKey).then((models) => {
        setFetchedModels(models)
      })
    }
  }, [autoModel])

  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      const settings = saveToLocalStorage({ [key]: value })
      onChange?.(settings)
      return settings
    },
    [onChange]
  )

  const handleChangeAutoModel = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setModel(event.target.value)
      updateSetting('model', event.target.value)
    },
    [updateSetting]
  )

  const handleChangeManualModel = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setModel(event.target.value)
      updateSetting('model', event.target.value)
    },
    [updateSetting]
  )

  const handleChangeBaseURL = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateSetting('baseURL', event.target.value)
    },
    [updateSetting]
  )

  const handleChangeApiKey = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateSetting('apiKey', event.target.value)
    },
    [updateSetting]
  )

  const handleChangeMcpServerURLs = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      updateSetting('mcpServerURLs', event.target.value)
    },
    [updateSetting]
  )

  const handleChangeTemperature = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(event.target.value)
      setTemperature(value)
      updateSetting('temperature', value)
    },
    [updateSetting]
  )

  const handleChangeMaxTokens = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value ? Number.parseFloat(event.target.value) : undefined
      updateSetting('maxTokens', value)
    },
    [updateSetting]
  )

  const handleToggleTemperature = useCallback(() => {
    const newValue = !temperatureEnabled
    setTemperatureEnabled(newValue)
    updateSetting('temperatureEnabled', newValue)
  }, [temperatureEnabled, updateSetting])

  const handleToggleAutoModel = useCallback(() => {
    const newValue = !autoModel
    setAutoModel(newValue)
    updateSetting('autoModel', newValue)
  }, [autoModel, updateSetting])

  const handleToggleFakeMode = useCallback(() => {
    const newValue = !fakeMode
    setFakeMode(newValue)
    updateSetting('fakeMode', newValue)
  }, [fakeMode, updateSetting])

  const handleToggleMarkdownPreview = useCallback(() => {
    const newValue = !markdownPreview
    setMarkdownPreview(newValue)
    updateSetting('markdownPreview', newValue)
  }, [markdownPreview, updateSetting])

  const handleToggleStreamMode = useCallback(() => {
    const newValue = !streamMode
    setStreamMode(newValue)
    updateSetting('streamMode', newValue)
  }, [streamMode, updateSetting])

  const handleToggleInteractiveMode = useCallback(() => {
    const newValue = !interactiveMode
    setInteractiveMode(newValue)
    updateSetting('interactiveMode', newValue)
  }, [interactiveMode, updateSetting])

  const handleToggleReasoningEffort = useCallback(() => {
    const newValue = !reasoningEffortEnabled
    setReasoningEffortEnabled(newValue)
    updateSetting('reasoningEffortEnabled', newValue)
  }, [reasoningEffortEnabled, updateSetting])

  const handleChangeReasoningEffort = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      setReasoningEffort(value)
      updateSetting('reasoningEffort', value)
    },
    [updateSetting]
  )

  // Merge default settings with current state
  const settings = useMemo(() => ({ ...defaultSettings, model }), [defaultSettings, model])

  return {
    settings,
    fetchedModels,
    temperature,
    temperatureEnabled,
    autoModel,
    fakeMode,
    markdownPreview,
    streamMode,
    interactiveMode,
    reasoningEffort,
    reasoningEffortEnabled,
    handleChangeAutoModel,
    handleChangeManualModel,
    handleChangeBaseURL,
    handleChangeApiKey,
    handleChangeMcpServerURLs,
    handleChangeTemperature,
    handleChangeMaxTokens,
    handleToggleTemperature,
    handleToggleAutoModel,
    handleToggleFakeMode,
    handleToggleMarkdownPreview,
    handleToggleStreamMode,
    handleToggleInteractiveMode,
    handleToggleReasoningEffort,
    handleChangeReasoningEffort,
  }
}
