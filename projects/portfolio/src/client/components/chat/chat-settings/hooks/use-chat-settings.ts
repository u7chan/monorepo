import { useLockBodyScroll } from '#/client/hooks/use-lock-body-scroll'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { ChatSettingsContextValue } from '../chat-settings-context'
import { useLocalStorageSettings } from './use-local-storage-settings'
import { useModelFetching } from './use-model-fetching'
import { useSettingsHandlers } from './use-settings-handlers'

interface UseChatSettingsOptions {
  showPopup?: boolean
  onChange?: (settings: Settings) => void
}

export function useChatSettings(options: UseChatSettingsOptions = {}): ChatSettingsContextValue {
  const { showPopup, onChange } = options

  useLockBodyScroll(showPopup ?? false)

  const storage = useLocalStorageSettings({ onChange })
  const models = useModelFetching({ autoModel: storage.autoModel })
  const handlers = useSettingsHandlers({
    setModel: storage.setModel,
    setTemperature: storage.setTemperature,
    setTemperatureEnabled: storage.setTemperatureEnabled,
    setAutoModel: storage.setAutoModel,
    setApiMode: storage.setApiMode,
    setFakeMode: storage.setFakeMode,
    setMarkdownPreview: storage.setMarkdownPreview,
    setStreamMode: storage.setStreamMode,
    setInteractiveMode: storage.setInteractiveMode,
    setReasoningEffort: storage.setReasoningEffort,
    setReasoningEffortEnabled: storage.setReasoningEffortEnabled,
    temperatureEnabled: storage.temperatureEnabled,
    autoModel: storage.autoModel,
    apiMode: storage.apiMode,
    fakeMode: storage.fakeMode,
    markdownPreview: storage.markdownPreview,
    streamMode: storage.streamMode,
    interactiveMode: storage.interactiveMode,
    reasoningEffortEnabled: storage.reasoningEffortEnabled,
    updateSetting: storage.updateSetting,
  })

  return {
    settings: storage.settings,
    temperature: storage.temperature,
    temperatureEnabled: storage.temperatureEnabled,
    autoModel: storage.autoModel,
    apiMode: storage.apiMode,
    fakeMode: storage.fakeMode,
    markdownPreview: storage.markdownPreview,
    streamMode: storage.streamMode,
    interactiveMode: storage.interactiveMode,
    reasoningEffort: storage.reasoningEffort,
    reasoningEffortEnabled: storage.reasoningEffortEnabled,
    ...models,
    ...handlers,
  }
}
