import { ToggleInput } from '#/client/components/input/toggle-input'
import { GearIcon } from '#/client/components/svg/gear-icon'
import { NewChatIcon } from '#/client/components/svg/new-chat-icon'
import { SidebarIcon } from '#/client/components/svg/sidebar-icon'
import { readFromLocalStorage, type Settings, saveToLocalStorage } from '#/client/storage/remote-storage-settings'
import type { AppType } from '#/server/app'
import { hc } from 'hono/client'
import { type ChangeEvent, useEffect, useMemo, useState } from 'react'

const client = hc<AppType>('/')

interface Props {
  showActions?: boolean
  showNewChat?: boolean
  showPopup?: boolean
  showSidebarToggle?: boolean
  onNewChat?: () => void
  onShowMenu?: () => void
  onToggleSidebar?: () => void
  onChange?: (settings: Settings) => void
  onHidePopup?: () => void
}

export function ChatSettings({
  showActions,
  showNewChat = true,
  showPopup,
  showSidebarToggle = true,
  onNewChat,
  onShowMenu,
  onToggleSidebar,
  onChange,
  onHidePopup,
}: Props) {
  const defaultSettings = useMemo(() => {
    return readFromLocalStorage()
  }, [])

  const [model, setModel] = useState(defaultSettings.model)
  const [temperature, setTemperature] = useState<number>(defaultSettings.temperature)
  const [temperatureEnabled, setTemperatureEnabled] = useState(defaultSettings?.temperatureEnabled ?? false)
  const [autoModel, setAutoModel] = useState(defaultSettings?.autoModel ?? false)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [fakeMode, setFakeMode] = useState(defaultSettings?.fakeMode ?? false)
  const [markdownPreview, setMarkdownPreview] = useState(defaultSettings?.markdownPreview ?? true)
  const [streamMode, setStreamMode] = useState(defaultSettings?.streamMode ?? true)
  const [interactiveMode, setInteractiveMode] = useState(defaultSettings?.interactiveMode ?? true)
  const [reasoningEffort, setReasoningEffort] = useState<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>(
    defaultSettings?.reasoningEffort ?? 'medium'
  )
  const [reasoningEffortEnabled, setReasoningEffortEnabled] = useState(defaultSettings?.reasoningEffortEnabled ?? false)

  const fetchModels = async (baseURL: string, apiKey: string) => {
    try {
      const response = await client.api['fetch-models'].$get({
        header: {
          'api-key': apiKey,
          'base-url': baseURL,
        },
      })
      if (response.ok) {
        return await response.json()
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
    }
    return []
  }

  useEffect(() => {
    if (autoModel) {
      const { baseURL, apiKey } = readFromLocalStorage()
      fetchModels(baseURL, apiKey).then((models) => {
        setFetchedModels(models)
      })
    }
  }, [autoModel])

  const handleClickNewChat = () => {
    onNewChat?.()
  }

  const handleClickShowMenu = () => {
    onShowMenu?.()
  }

  const handleClickToggleSidebar = () => {
    onToggleSidebar?.()
  }

  const handleChangeAutoModel = (event: ChangeEvent<HTMLSelectElement>) => {
    setModel(event.target.value)
    const settings = saveToLocalStorage({ model: event.target.value })
    onChange?.(settings)
  }

  const handleChangeModel = (event: ChangeEvent<HTMLInputElement>) => {
    setModel(event.target.value)
    const settings = saveToLocalStorage({ model: event.target.value })
    onChange?.(settings)
  }

  const handleChangeBaseURL = (event: ChangeEvent<HTMLInputElement>) => {
    const settings = saveToLocalStorage({ baseURL: event.target.value })
    onChange?.(settings)
  }

  const handleChangeApiKey = (event: ChangeEvent<HTMLInputElement>) => {
    const settings = saveToLocalStorage({ apiKey: event.target.value })
    onChange?.(settings)
  }

  const handleChangeMcpServerURLs = (event: ChangeEvent<HTMLInputElement>) => {
    const settings = saveToLocalStorage({ mcpServerURLs: event.target.value })
    onChange?.(settings)
  }

  const handleChangeTemperature = (event: ChangeEvent<HTMLInputElement>) => {
    setTemperature(Number.parseFloat(event.target.value))
    const settings = saveToLocalStorage({
      temperature: Number.parseFloat(event.target.value),
    })
    onChange?.(settings)
  }

  const handleChangeMaxTokens = (event: ChangeEvent<HTMLInputElement>) => {
    const settings = saveToLocalStorage({
      maxTokens: event.target.value ? Number.parseFloat(event.target.value) : undefined,
    })
    onChange?.(settings)
  }

  const handleClickTemperatureEnabled = () => {
    const newTemperatureEnabled = !temperatureEnabled
    setTemperatureEnabled(newTemperatureEnabled)
    const settings = saveToLocalStorage({
      temperatureEnabled: newTemperatureEnabled,
    })
    onChange?.(settings)
  }

  const handleClickAutoModel = () => {
    const newAutoModel = !autoModel
    setAutoModel(newAutoModel)
    const settings = saveToLocalStorage({ autoModel: newAutoModel })
    onChange?.(settings)
  }

  const handleClickFakeMode = () => {
    const newFakeMode = !fakeMode
    setFakeMode(newFakeMode)
    const settings = saveToLocalStorage({ fakeMode: newFakeMode })
    onChange?.(settings)
  }

  const handleClickShowMarkdownPreview = () => {
    const newMarkdownPreview = !markdownPreview
    setMarkdownPreview(newMarkdownPreview)
    const settings = saveToLocalStorage({ markdownPreview: newMarkdownPreview })
    onChange?.(settings)
  }

  const handleClickStreamMode = () => {
    const newStreamMode = !streamMode
    setStreamMode(newStreamMode)
    const settings = saveToLocalStorage({ streamMode: newStreamMode })
    onChange?.(settings)
  }

  const handleClickInteractiveMode = () => {
    const newInteractiveMode = !interactiveMode
    setInteractiveMode(newInteractiveMode)
    const settings = saveToLocalStorage({ interactiveMode: newInteractiveMode })
    onChange?.(settings)
  }

  const handleClickReasoningEffortEnabled = () => {
    const newReasoningEffortEnabled = !reasoningEffortEnabled
    setReasoningEffortEnabled(newReasoningEffortEnabled)
    const settings = saveToLocalStorage({
      reasoningEffortEnabled: newReasoningEffortEnabled,
    })
    onChange?.(settings)
  }

  const handleChangeReasoningEffort = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    setReasoningEffort(value)
    const settings = saveToLocalStorage({ reasoningEffort: value })
    onChange?.(settings)
  }

  // Prevent body scroll when panel is open
  useEffect(() => {
    if (showPopup) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [showPopup])

  return (
    <>
      {/* Button Group - Fixed position (top-left, accounting for sidebar on desktop) */}
      <div className='fixed top-0 left-0 z-30 p-4 md:left-40'>
        {showActions && (
          <div className='flex flex-col items-center gap-2 sm:flex-row'>
            {/* Sidebar Toggle - Mobile only (shown only when logged in) */}
            {showSidebarToggle && (
              <button
                type='button'
                onClick={handleClickToggleSidebar}
                className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 md:hidden dark:bg-gray-800 dark:focus:ring-gray-500 dark:hover:bg-gray-700'
              >
                <SidebarIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
              </button>
            )}
            {showNewChat && (
              <button
                type='button'
                onClick={handleClickNewChat}
                className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-gray-800 dark:focus:ring-gray-500 dark:hover:bg-gray-700'
              >
                <NewChatIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
              </button>
            )}
            <button
              type='button'
              onClick={handleClickShowMenu}
              className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-gray-800 dark:focus:ring-gray-500 dark:hover:bg-gray-700'
            >
              <GearIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
            </button>
            <span className='hidden max-w-48 truncate text-xs font-medium text-gray-900 sm:block dark:text-gray-200'>
              {fakeMode ? 'Fake Mode' : model}
            </span>
          </div>
        )}
      </div>

      {/* Overlay Background */}
      {showPopup && (
        <div
          className='fixed inset-0 z-40 bg-black/50 transition-opacity duration-300'
          onClick={onHidePopup}
          aria-hidden='true'
        />
      )}

      {/* Slide-in Panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[400px] lg:w-[450px] transform bg-white shadow-2xl transition-transform duration-300 ease-in-out dark:bg-gray-800 ${
          showPopup ? 'translate-x-0' : 'translate-x-full'
        }`}
        role='dialog'
        aria-modal='true'
        aria-labelledby='chat-settings-title'
      >
        {/* Header */}
        <div className='flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700'>
          <h2 id='chat-settings-title' className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
            Chat Settings
          </h2>
          {/* Close button - visible on mobile */}
          <button
            type='button'
            onClick={onHidePopup}
            className='rounded-md p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 sm:hidden dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200'
            aria-label='Close settings'
          >
            <svg className='h-6 w-6' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
            </svg>
          </button>
        </div>

        {/* Settings Content - Scrollable */}
        <div
          className='h-[calc(100%-4rem)] overflow-y-auto p-4 pb-[env(safe-area-inset-bottom,0px)]'
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        >
          <div className='flex flex-col gap-5'>
            {/* Model Section */}
            <section className='space-y-3'>
              <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Model</h3>
              <div className='space-y-3'>
                {/* Model Selection */}
                <div className='space-y-2'>
                  <label
                    className={`block text-sm font-medium ${fakeMode ? 'text-gray-400' : 'text-gray-700 dark:text-gray-300'}`}
                  >
                    Model
                  </label>
                  <div className='flex items-center gap-2'>
                    {autoModel ? (
                      <div className='flex-1'>
                        <select
                          name='model'
                          className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all duration-200 ${
                            fakeMode
                              ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                              : 'border-gray-300 bg-white text-gray-900 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
                          }`}
                          onChange={handleChangeAutoModel}
                          disabled={fakeMode}
                          value={model}
                        >
                          {fetchedModels.length === 0 ? (
                            <option>Loading...</option>
                          ) : (
                            fetchedModels.map((modelName) => (
                              <option key={modelName} value={modelName}>
                                {modelName}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                    ) : (
                      <input
                        name='model'
                        defaultValue={model}
                        disabled={fakeMode}
                        onChange={handleChangeModel}
                        placeholder='Enter model name'
                        className={`flex-1 rounded-md border px-3 py-2 text-sm outline-none transition-all ${
                          fakeMode
                            ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                            : 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
                        }`}
                      />
                    )}
                  </div>
                </div>

                {/* Auto Model Toggle */}
                <ToggleInput
                  label='Auto Fetch Models'
                  labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
                  value={autoModel}
                  onClick={handleClickAutoModel}
                />
              </div>
            </section>

            {/* API Configuration */}
            <section className='space-y-3'>
              <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>API Configuration</h3>
              <div className='space-y-3'>
                {/* Base URL */}
                <div className='space-y-2'>
                  <label
                    className={`block text-sm font-medium ${fakeMode ? 'text-gray-400' : 'text-gray-700 dark:text-gray-300'}`}
                  >
                    Base URL
                  </label>
                  <input
                    name='baseURL'
                    defaultValue={defaultSettings.baseURL || 'https://api.openai.com/v1'}
                    disabled={fakeMode}
                    onChange={handleChangeBaseURL}
                    placeholder='https://api.openai.com/v1'
                    className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all ${
                      fakeMode
                        ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                        : 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
                    }`}
                  />
                </div>

                {/* API Key */}
                <div className='space-y-2'>
                  <label
                    className={`block text-sm font-medium ${fakeMode ? 'text-gray-400' : 'text-gray-700 dark:text-gray-300'}`}
                  >
                    API Key
                  </label>
                  <input
                    name='apiKey'
                    type='password'
                    disabled={fakeMode}
                    defaultValue={defaultSettings.apiKey}
                    onChange={handleChangeApiKey}
                    placeholder='Enter your API key'
                    className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all ${
                      fakeMode
                        ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                        : 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
                    }`}
                  />
                </div>

                {/* MCP Server URLs */}
                <div className='space-y-2'>
                  <label
                    className={`block text-sm font-medium ${fakeMode ? 'text-gray-400' : 'text-gray-700 dark:text-gray-300'}`}
                  >
                    MCP Server URLs <span className='text-xs text-gray-500'>(comma separated)</span>
                  </label>
                  <input
                    name='mcpServerURLs'
                    defaultValue={defaultSettings.mcpServerURLs || ''}
                    disabled={fakeMode}
                    onChange={handleChangeMcpServerURLs}
                    placeholder='http://localhost:3001, http://localhost:3002'
                    className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all ${
                      fakeMode
                        ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                        : 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
                    }`}
                  />
                </div>
              </div>
            </section>

            {/* Parameters */}
            <section className='space-y-3'>
              <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Parameters</h3>
              <div className='space-y-4'>
                {/* Temperature */}
                <div className='space-y-2'>
                  <div className='flex items-center justify-between'>
                    <label className={`block text-sm font-medium ${temperatureEnabled ? '' : 'text-gray-400'}`}>
                      Temperature
                    </label>
                    <span
                      className={`text-sm ${temperatureEnabled ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400'}`}
                    >
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
                      onChange={handleChangeTemperature}
                      disabled={!temperatureEnabled}
                      className={`h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-primary-400 accent-primary-800 dark:bg-primary-600 dark:accent-primary-500 ${
                        temperatureEnabled ? '' : 'cursor-not-allowed opacity-50'
                      }`}
                    />
                    <ToggleInput value={temperatureEnabled} onClick={handleClickTemperatureEnabled} />
                  </div>
                </div>

                {/* Max Tokens */}
                <div className='space-y-2'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>Max Tokens</label>
                  <input
                    name='maxTokens'
                    type='number'
                    min={1}
                    max={4096}
                    defaultValue={defaultSettings.maxTokens}
                    onChange={handleChangeMaxTokens}
                    placeholder='Max tokens'
                    className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
                  />
                </div>

                {/* Reasoning Effort */}
                <div className='space-y-2'>
                  <label className={`block text-sm font-medium ${reasoningEffortEnabled ? '' : 'text-gray-400'}`}>
                    Reasoning Effort
                  </label>
                  <div className='flex items-center gap-3'>
                    <select
                      name='reasoningEffort'
                      value={reasoningEffort}
                      onChange={handleChangeReasoningEffort}
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
                    <ToggleInput value={reasoningEffortEnabled} onClick={handleClickReasoningEffortEnabled} />
                  </div>
                </div>
              </div>
            </section>

            {/* Display Options */}
            <section className='space-y-3'>
              <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Display Options</h3>
              <div className='space-y-3'>
                <ToggleInput
                  label='Markdown Preview'
                  labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
                  value={markdownPreview}
                  onClick={handleClickShowMarkdownPreview}
                />
                <ToggleInput
                  label='Stream Mode'
                  labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
                  value={streamMode}
                  onClick={handleClickStreamMode}
                />
                <ToggleInput
                  label='Interactive Mode'
                  labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
                  value={interactiveMode}
                  onClick={handleClickInteractiveMode}
                />
              </div>
            </section>

            {/* Debug Options */}
            <section className='space-y-3'>
              <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Debug Options</h3>
              <ToggleInput
                label='Fake Mode'
                labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
                value={fakeMode}
                onClick={handleClickFakeMode}
              />
            </section>
          </div>

          {/* Bottom spacing for safe area */}
          <div className='h-6' />
        </div>
      </div>
    </>
  )
}
