import { ToggleInput } from '#/client/components/input/toggle-input'

interface Props {
  autoModel: boolean
  onClick: () => void
}

export function AutoModelToggle({ autoModel, onClick }: Props) {
  return (
    <ToggleInput
      label='Auto Fetch Models'
      labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
      value={autoModel}
      onClick={onClick}
    />
  )
}
