import { useChatSettingsContext } from './chat-settings-context'

export function ModelSelector() {
  const {
    settings,
    autoModel,
    fakeMode,
    fetchedModels,
    isLoadingModels,
    fetchError,
    handleChangeAutoModel,
    handleChangeManualModel,
  } = useChatSettingsContext()

  if (autoModel) {
    return (
      <div className='space-y-1'>
        <div className='relative'>
          <select
            name='model'
            className={`w-full appearance-none rounded-md border px-3 py-2 pr-9 text-sm outline-none transition-all duration-200 ${
              fakeMode
                ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                : 'border-gray-300 bg-white text-gray-900 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
            }`}
            onChange={handleChangeAutoModel}
            disabled={fakeMode || isLoadingModels || fetchedModels.length === 0}
            value={settings.model}
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
          <svg
            viewBox='0 0 20 20'
            aria-hidden='true'
            className={`pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 ${
              fakeMode ? 'stroke-gray-400' : 'stroke-gray-600 dark:stroke-gray-300'
            }`}
            fill='none'
          >
            <path d='M5 7.5L10 12.5L15 7.5' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
        </div>
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
      defaultValue={settings.model}
      disabled={fakeMode}
      onChange={handleChangeManualModel}
      placeholder='Enter model name'
      className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all ${
        fakeMode
          ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
          : 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
      }`}
    />
  )
}
