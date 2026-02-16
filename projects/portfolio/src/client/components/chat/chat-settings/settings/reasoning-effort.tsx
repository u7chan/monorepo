import { ToggleInput } from '#/client/components/input/toggle-input'
import { type ChangeEvent } from 'react'

interface Props {
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  reasoningEffortEnabled: boolean
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void
  onToggle: () => void
}

export function ReasoningEffort({ reasoningEffort, reasoningEffortEnabled, onChange, onToggle }: Props) {
  return (
    <div className='space-y-2'>
      <label
        className={`block text-sm font-medium ${
          reasoningEffortEnabled ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'
        }`}
      >
        Reasoning Effort
      </label>
      <div className='flex items-center gap-3'>
        <select
          name='reasoningEffort'
          value={reasoningEffort}
          onChange={onChange}
          disabled={!reasoningEffortEnabled}
          className={`flex-1 rounded-md border px-3 py-2 text-sm outline-none ${
            reasoningEffortEnabled
              ? 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
              : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
          }`}
        >
          <option value='none'>none</option>
          <option value='minimal'>minimal</option>
          <option value='low'>low</option>
          <option value='medium'>medium</option>
          <option value='high'>high</option>
          <option value='xhigh'>xhigh</option>
        </select>
        <ToggleInput value={reasoningEffortEnabled} onClick={onToggle} />
      </div>
    </div>
  )
}
