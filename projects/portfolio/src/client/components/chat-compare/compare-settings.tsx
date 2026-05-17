import { type ChangeEvent, useCallback } from 'react'
import type { ApiMode } from '#/types'
import type { CompareSettings } from './hooks/use-compare-settings'

interface CompareSettingsProps {
  settings: CompareSettings
  open: boolean
  onUpdate: (settings: CompareSettings) => void
  onClose: () => void
}

export function CompareSettings({ settings, open, onUpdate, onClose }: CompareSettingsProps) {
  const handleChange = useCallback(
    (field: keyof CompareSettings, value: string) => {
      onUpdate({ ...settings, [field]: value })
    },
    [onUpdate, settings]
  )

  const handleApiModeChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value as ApiMode
      onUpdate({ ...settings, apiMode: value })
    },
    [onUpdate, settings]
  )

  if (!open) return null

  return (
    <div
      className='border-y border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800'
      onClick={onClose}
    >
      <div className='mx-auto flex max-w-(--breakpoint-lg) flex-wrap items-end gap-4' onClick={(e) => e.stopPropagation()}>
        <div className='flex min-w-0 flex-1 flex-col gap-1'>
          <label htmlFor='compare-base-url' className='text-xs text-gray-500 dark:text-gray-400'>
            Base URL
          </label>
          <input
            id='compare-base-url'
            type='text'
            value={settings.baseURL}
            onChange={(e) => handleChange('baseURL', e.target.value)}
            placeholder='https://api.openai.com/v1'
            className='w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder-gray-400 focus:border-primary-700 focus:outline-none focus:ring-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-500'
          />
        </div>
        <div className='flex min-w-0 flex-1 flex-col gap-1'>
          <label htmlFor='compare-api-key' className='text-xs text-gray-500 dark:text-gray-400'>
            API Key
          </label>
          <input
            id='compare-api-key'
            type='password'
            value={settings.apiKey}
            onChange={(e) => handleChange('apiKey', e.target.value)}
            placeholder='sk-...'
            className='w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder-gray-400 focus:border-primary-700 focus:outline-none focus:ring-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-500'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <label htmlFor='compare-api-mode' className='text-xs text-gray-500 dark:text-gray-400'>
            API Mode
          </label>
          <select
            id='compare-api-mode'
            value={settings.apiMode}
            onChange={handleApiModeChange}
            className='rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-primary-700 focus:outline-none focus:ring-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-white'
          >
            <option value='chat_completions'>Chat Completions</option>
            <option value='responses'>Responses</option>
          </select>
        </div>
        <button
          type='button'
          onClick={onClose}
          className='flex shrink-0 cursor-pointer items-center rounded-md bg-gray-200 px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500'
        >
          Close
        </button>
      </div>
    </div>
  )
}
