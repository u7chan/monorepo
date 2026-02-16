import { ToggleInput } from '#/client/components/input/toggle-input'
import { type ChangeEvent } from 'react'

interface Props {
  temperature: number
  temperatureEnabled: boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onToggle: () => void
}

export function TemperatureSlider({ temperature, temperatureEnabled, onChange, onToggle }: Props) {
  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <label
          className={`block text-sm font-medium ${
            temperatureEnabled ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'
          }`}
        >
          Temperature
        </label>
        <span className={`text-sm ${temperatureEnabled ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400'}`}>
          {temperature.toFixed(2)}
        </span>
      </div>
      <div className='flex items-center gap-3'>
        <input
          name='temperature'
          type='range'
          min='0'
          max='1'
          step='0.01'
          value={temperature}
          onChange={onChange}
          disabled={!temperatureEnabled}
          className={`h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-primary-400 accent-primary-800 dark:bg-primary-600 dark:accent-primary-500 ${
            temperatureEnabled ? '' : 'cursor-not-allowed opacity-50'
          }`}
        />
        <ToggleInput value={temperatureEnabled} onClick={onToggle} />
      </div>
    </div>
  )
}
