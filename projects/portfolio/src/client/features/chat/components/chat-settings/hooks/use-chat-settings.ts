import type { ChatSettingsContextValue } from '#/client/features/chat/components/chat-settings/chat-settings-context'
import { useLockBodyScroll } from '#/client/shared/hooks/use-lock-body-scroll'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'
import { useLocalStorageSettings } from './use-local-storage-settings'
import { useModelFetching } from './use-model-fetching'
import { useSettingsHandlers } from './use-settings-handlers'

interface UseChatSettingsOptions {
  settings: Settings
  showPopup?: boolean
  onChange?: (settings: Settings) => void
}

export function useChatSettings({ settings, showPopup, onChange }: UseChatSettingsOptions): ChatSettingsContextValue {
  useLockBodyScroll(showPopup ?? false)

  const storage = useLocalStorageSettings({ onChange })
  const models = useModelFetching({ autoModel: settings.autoModel })
  const handlers = useSettingsHandlers({
    setModel: storage.setModel,
    setTemperature: storage.setTemperature,
    setTemperatureEnabled: storage.setTemperatureEnabled,
    setAutoModel: storage.setAutoModel,
    setApiMode: storage.setApiMode,
    setFakeMode: storage.setFakeMode,
    setMarkdownPreview: storage.setMarkdownPreview,
    setStreamMode: storage.setStreamMode,
    setIncludeChatHistory: storage.setIncludeChatHistory,
    setSendImagesOnlyOnce: storage.setSendImagesOnlyOnce,
    setReasoningEffort: storage.setReasoningEffort,
    setReasoningEffortEnabled: storage.setReasoningEffortEnabled,
    temperatureEnabled: settings.temperatureEnabled,
    autoModel: settings.autoModel,
    apiMode: settings.apiMode,
    fakeMode: settings.fakeMode,
    markdownPreview: settings.markdownPreview,
    streamMode: settings.streamMode,
    includeChatHistory: settings.includeChatHistory,
    sendImagesOnlyOnce: settings.sendImagesOnlyOnce,
    reasoningEffortEnabled: settings.reasoningEffortEnabled,
    updateSetting: storage.updateSetting,
  })

  return {
    settings,
    temperature: settings.temperature,
    temperatureEnabled: settings.temperatureEnabled,
    autoModel: settings.autoModel,
    apiMode: settings.apiMode,
    fakeMode: settings.fakeMode,
    markdownPreview: settings.markdownPreview,
    streamMode: settings.streamMode,
    includeChatHistory: settings.includeChatHistory,
    sendImagesOnlyOnce: settings.sendImagesOnlyOnce,
    reasoningEffort: settings.reasoningEffort,
    reasoningEffortEnabled: settings.reasoningEffortEnabled,
    ...models,
    ...handlers,
  }
}
