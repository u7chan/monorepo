import { type ChangeEvent } from 'react'

interface Props {
  model: string
  autoModel: boolean
  fakeMode: boolean
  fetchedModels: string[]
  isLoadingModels: boolean
  fetchError: string | null
  onChangeAutoModel: (event: ChangeEvent<HTMLSelectElement>) => void
  onChangeManualModel: (event: ChangeEvent<HTMLInputElement>) => void
}

export function ModelSelector({
  model,
  autoModel,
  fakeMode,
  fetchedModels,
  isLoadingModels,
  fetchError,
  onChangeAutoModel,
  onChangeManualModel,
}: Props) {
  if (autoModel) {
    return (
      <div className='space-y-1'>
        <select
          name='model'
          className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all duration-200 ${
            fakeMode
              ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
              : 'border-gray-300 bg-white text-gray-900 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
          }`}
          onChange={onChangeAutoModel}
          disabled={fakeMode || isLoadingModels || fetchedModels.length === 0}
          value={model}
        >
          {isLoadingModels ? (
            <option>Loading...</option>
          ) : fetchError ? (
            <option>Error: {fetchError}</option>
          ) : fetchedModels.length === 0 ? (
            <option>No models available</option>
          ) : (
            fetchedModels.map((modelName) => (
              <option key={modelName} value={modelName}>
                {modelName}
              </option>
            ))
          )}
        </select>
        {fetchError && (
          <p className='text-xs text-red-600 dark:text-red-400'>
            {fetchError}. Please check your Base URL and API key.
          </p>
        )}
      </div>
    )
  }

  return (
    <input
      name='model'
      defaultValue={model}
      disabled={fakeMode}
      onChange={onChangeManualModel}
      placeholder='Enter model name'
      className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all ${
        fakeMode
          ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
          : 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
      }`}
    />
  )
}
