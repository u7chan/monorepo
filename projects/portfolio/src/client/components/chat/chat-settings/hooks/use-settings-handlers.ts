import type { Settings } from '#/client/storage/remote-storage-settings'
import type { ChangeEvent, Dispatch, SetStateAction } from 'react'
import { useCallback } from 'react'

type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

interface UseSettingsHandlersDeps {
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
  temperatureEnabled: boolean
  autoModel: boolean
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  reasoningEffortEnabled: boolean
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Settings
}

interface UseSettingsHandlersReturn {
  handleChangeAutoModel: (event: ChangeEvent<HTMLSelectElement>) => void
  handleChangeManualModel: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeBaseURL: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeApiKey: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeTemperature: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeMaxTokens: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeReasoningEffort: (event: ChangeEvent<HTMLSelectElement>) => void
  handleToggleTemperature: () => void
  handleToggleAutoModel: () => void
  handleToggleFakeMode: () => void
  handleToggleMarkdownPreview: () => void
  handleToggleStreamMode: () => void
  handleToggleInteractiveMode: () => void
  handleToggleReasoningEffort: () => void
}

export function useSettingsHandlers(deps: UseSettingsHandlersDeps): UseSettingsHandlersReturn {
  const {
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
    temperatureEnabled,
    autoModel,
    fakeMode,
    markdownPreview,
    streamMode,
    interactiveMode,
    reasoningEffortEnabled,
    updateSetting,
  } = deps

  const handleChangeAutoModel = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setModel(event.target.value)
      updateSetting('model', event.target.value)
    },
    [setModel, updateSetting]
  )

  const handleChangeManualModel = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setModel(event.target.value)
      updateSetting('model', event.target.value)
    },
    [setModel, updateSetting]
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

  const handleChangeTemperature = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(event.target.value)
      setTemperature(value)
      updateSetting('temperature', value)
    },
    [setTemperature, updateSetting]
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
  }, [temperatureEnabled, setTemperatureEnabled, updateSetting])

  const handleToggleAutoModel = useCallback(() => {
    const newValue = !autoModel
    setAutoModel(newValue)
    updateSetting('autoModel', newValue)
  }, [autoModel, setAutoModel, updateSetting])

  const handleToggleFakeMode = useCallback(() => {
    const newValue = !fakeMode
    setFakeMode(newValue)
    updateSetting('fakeMode', newValue)
  }, [fakeMode, setFakeMode, updateSetting])

  const handleToggleMarkdownPreview = useCallback(() => {
    const newValue = !markdownPreview
    setMarkdownPreview(newValue)
    updateSetting('markdownPreview', newValue)
  }, [markdownPreview, setMarkdownPreview, updateSetting])

  const handleToggleStreamMode = useCallback(() => {
    const newValue = !streamMode
    setStreamMode(newValue)
    updateSetting('streamMode', newValue)
  }, [streamMode, setStreamMode, updateSetting])

  const handleToggleInteractiveMode = useCallback(() => {
    const newValue = !interactiveMode
    setInteractiveMode(newValue)
    updateSetting('interactiveMode', newValue)
  }, [interactiveMode, setInteractiveMode, updateSetting])

  const handleToggleReasoningEffort = useCallback(() => {
    const newValue = !reasoningEffortEnabled
    setReasoningEffortEnabled(newValue)
    updateSetting('reasoningEffortEnabled', newValue)
  }, [reasoningEffortEnabled, setReasoningEffortEnabled, updateSetting])

  const handleChangeReasoningEffort = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value as ReasoningEffortLevel
      setReasoningEffort(value)
      updateSetting('reasoningEffort', value)
    },
    [setReasoningEffort, updateSetting]
  )

  return {
    handleChangeAutoModel,
    handleChangeManualModel,
    handleChangeBaseURL,
    handleChangeApiKey,
    handleChangeTemperature,
    handleChangeMaxTokens,
    handleChangeReasoningEffort,
    handleToggleTemperature,
    handleToggleAutoModel,
    handleToggleFakeMode,
    handleToggleMarkdownPreview,
    handleToggleStreamMode,
    handleToggleInteractiveMode,
    handleToggleReasoningEffort,
  }
}
