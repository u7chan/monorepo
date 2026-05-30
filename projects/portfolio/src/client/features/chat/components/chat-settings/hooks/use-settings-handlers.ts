import type { ChangeEvent, Dispatch, SetStateAction } from 'react'
import { useCallback } from 'react'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'
import type { ApiMode } from '#/types'

type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

interface UseSettingsHandlersDeps {
  setModel: Dispatch<SetStateAction<string>>
  setTemperature: Dispatch<SetStateAction<number>>
  setTemperatureEnabled: Dispatch<SetStateAction<boolean>>
  setAutoModel: Dispatch<SetStateAction<boolean>>
  setApiMode: Dispatch<SetStateAction<ApiMode>>
  setFakeMode: Dispatch<SetStateAction<boolean>>
  setMarkdownPreview: Dispatch<SetStateAction<boolean>>
  setStreamMode: Dispatch<SetStateAction<boolean>>
  setIncludeChatHistory: Dispatch<SetStateAction<boolean>>
  setSendImagesOnlyOnce: Dispatch<SetStateAction<boolean>>
  setReasoningEffort: Dispatch<SetStateAction<ReasoningEffortLevel>>
  setReasoningEffortEnabled: Dispatch<SetStateAction<boolean>>
  temperatureEnabled: boolean
  autoModel: boolean
  apiMode: ApiMode
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
  includeChatHistory: boolean
  sendImagesOnlyOnce: boolean
  reasoningEffortEnabled: boolean
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Settings
}

interface UseSettingsHandlersReturn {
  handleChangeAutoModel: (event: ChangeEvent<HTMLSelectElement>) => void
  handleChangeManualModel: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeBaseURL: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeApiKey: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeApiMode: (event: ChangeEvent<HTMLSelectElement>) => void
  handleChangeTemperature: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeMaxTokens: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeReasoningEffort: (event: ChangeEvent<HTMLSelectElement>) => void
  handleToggleTemperature: () => void
  handleToggleAutoModel: () => void
  handleToggleFakeMode: () => void
  handleToggleMarkdownPreview: () => void
  handleToggleStreamMode: () => void
  handleToggleIncludeChatHistory: () => void
  handleToggleSendImagesOnlyOnce: () => void
  handleToggleReasoningEffort: () => void
}

export function useSettingsHandlers(deps: UseSettingsHandlersDeps): UseSettingsHandlersReturn {
  const {
    setModel,
    setTemperature,
    setTemperatureEnabled,
    setAutoModel,
    setApiMode,
    setFakeMode,
    setMarkdownPreview,
    setStreamMode,
    setIncludeChatHistory,
    setSendImagesOnlyOnce,
    setReasoningEffort,
    setReasoningEffortEnabled,
    temperatureEnabled,
    autoModel,
    apiMode,
    fakeMode,
    markdownPreview,
    streamMode,
    includeChatHistory,
    sendImagesOnlyOnce,
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

  const handleChangeApiMode = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value as ApiMode
      const nextSettings = updateSetting('apiMode', value)
      setApiMode(nextSettings.apiMode)
      setFakeMode(nextSettings.fakeMode)
    },
    [setApiMode, setFakeMode, updateSetting]
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
    if (apiMode === 'responses') {
      setFakeMode(false)
      return
    }

    const newValue = !fakeMode
    const nextSettings = updateSetting('fakeMode', newValue)
    setFakeMode(nextSettings.fakeMode)
  }, [apiMode, fakeMode, setFakeMode, updateSetting])

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

  const handleToggleIncludeChatHistory = useCallback(() => {
    const newValue = !includeChatHistory
    setIncludeChatHistory(newValue)
    updateSetting('includeChatHistory', newValue)
  }, [includeChatHistory, setIncludeChatHistory, updateSetting])

  const handleToggleSendImagesOnlyOnce = useCallback(() => {
    const newValue = !sendImagesOnlyOnce
    setSendImagesOnlyOnce(newValue)
    updateSetting('sendImagesOnlyOnce', newValue)
  }, [sendImagesOnlyOnce, setSendImagesOnlyOnce, updateSetting])

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
    handleChangeApiMode,
    handleChangeTemperature,
    handleChangeMaxTokens,
    handleChangeReasoningEffort,
    handleToggleTemperature,
    handleToggleAutoModel,
    handleToggleFakeMode,
    handleToggleMarkdownPreview,
    handleToggleStreamMode,
    handleToggleIncludeChatHistory,
    handleToggleSendImagesOnlyOnce,
    handleToggleReasoningEffort,
  }
}
