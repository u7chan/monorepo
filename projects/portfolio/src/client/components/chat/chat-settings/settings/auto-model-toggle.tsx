import { useChatSettingsContext } from '#/client/components/chat/chat-settings/chat-settings-context'
import { ToggleInput } from '#/client/components/input/toggle-input'

export function AutoModelToggle() {
  const { autoModel, handleToggleAutoModel } = useChatSettingsContext()

  return (
    <ToggleInput
      label='Auto Fetch Models'
      labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
      value={autoModel}
      onClick={handleToggleAutoModel}
    />
  )
}
