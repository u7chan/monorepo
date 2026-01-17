import { readFromLocalStorage, type Settings, saveToLocalStorage } from '#/client/components/chat/remoteStorageSettings'
import { ToggleInput } from '#/client/components/input/ToggleInput'
import { GearIcon } from '#/client/components/svg/GearIcon'
import { NewChatIcon } from '#/client/components/svg/NewChatIcon'
import type { AppType } from '#/server/app'
import { hc } from 'hono/client'
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'

const client = hc<AppType>('/')

interface Props {
  showActions?: boolean
  showNewChat?: boolean
  showPopup?: boolean
  onNewChat?: () => void
  onShowMenu?: () => void
  onChange?: (settings: Settings) => void
  onHidePopup?: () => void
}

export function ChatSettings({
  showActions,
  showNewChat = true,
  showPopup,
  onNewChat,
  onShowMenu,
  onChange,
  onHidePopup,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)

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

  // 領域外クリックでメニューを閉じる
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        onHidePopup?.()
      }
    }
    // メニューが開いているときだけリスナをつける
    if (showPopup) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showPopup])

  return (
    <div className='fixed inline-block p-4' ref={wrapperRef}>
      {/* ボタン群 */}
      {showActions && (
        <div className='flex items-center gap-2'>
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
          <span className='text-xs font-medium text-gray-900 dark:text-gray-200'>{model}</span>
        </div>
      )}
      {/* ポップアップメニュー */}
      <div
        className={`absolute top-15 ${showNewChat ? 'left-25' : 'left-15'} z-100 grid w-[420px] gap-2 rounded border border-gray-200 bg-white p-2 opacity-0 shadow-xl transition-opacity duration-100 ease-in dark:border-gray-600 dark:bg-gray-800 ${showPopup ? 'opacity-100' : 'pointer-events-none'}`}
      >
        <div className='flex items-center justify-between gap-2'>
          <span
            className={`ml-1 w-[83px] font-medium text-gray-900 text-sm dark:text-gray-200 ${fakeMode ? 'opacity-50' : ''}`}
          >
            Model
          </span>
          <div className='flex flex-1 items-center gap-2'>
            {autoModel ? (
              <div className='flex-1'>
                <select
                  name='model'
                  className={`w-[243px] ${
                    fakeMode
                      ? 'cursor-not-allowed border-gray-300 text-gray-500'
                      : 'cursor-pointer border-gray-300 bg-white text-gray-900 hover:border-gray-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-200'
                  } rounded-sm border px-1 py-1 outline-none transition-all duration-200`}
                  onChange={handleChangeAutoModel}
                  disabled={fakeMode}
                >
                  {fetchedModels.length === 0 ? (
                    <option>Loading...</option>
                  ) : (
                    fetchedModels.map((modelName) => (
                      <option key={modelName} value={modelName} selected={modelName === model}>
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
                disabled={fakeMode || autoModel}
                onChange={handleChangeModel}
                placeholder='model'
                className={`flex-1 rounded-sm border border-gray-300 bg-white px-2 py-1 text-gray-900 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-gray-500 ${fakeMode || autoModel ? 'cursor-not-allowed opacity-50' : ''}`}
              />
            )}
            <ToggleInput value={autoModel} onClick={handleClickAutoModel} />
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <span
            className={`ml-1 w-[110px] font-medium text-gray-900 text-sm dark:text-gray-200 ${fakeMode ? 'opacity-50' : ''}`}
          >
            BaseURL
          </span>
          <input
            name='baseURL'
            defaultValue={defaultSettings.baseURL || 'https://api.openai.com/v1'}
            disabled={fakeMode}
            onChange={handleChangeBaseURL}
            className={`w-full rounded-sm border border-gray-300 bg-white px-2 py-1 text-gray-900 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-gray-500 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <div className='flex items-center gap-2'>
          <span
            className={`ml-1 w-[110px] font-medium text-gray-900 text-sm dark:text-gray-200 ${fakeMode ? 'opacity-50' : ''}`}
          >
            API KEY
          </span>
          <input
            name='apiKey'
            type='password'
            disabled={fakeMode}
            defaultValue={defaultSettings.apiKey}
            onChange={handleChangeApiKey}
            className={`w-full rounded-sm border border-gray-300 bg-white px-2 py-1 text-gray-900 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-gray-500 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <div className='flex items-center gap-2'>
          <span
            className={`ml-1 w-[110px] font-medium text-gray-900 text-xs dark:text-gray-200 ${fakeMode ? 'opacity-50' : ''}`}
          >
            MCP Server URLs (,)
          </span>
          <input
            name='mcpServerURLs'
            defaultValue={defaultSettings.mcpServerURLs || ''}
            disabled={fakeMode}
            onChange={handleChangeMcpServerURLs}
            className={`w-full rounded-sm border border-gray-300 bg-white px-2 py-1 text-gray-900 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-gray-500 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <ToggleInput label='Fake Mode' value={fakeMode} onClick={handleClickFakeMode} />
        <div className='flex items-center gap-2'>
          <span
            className={`ml-1 w-[110px] font-medium text-gray-900 text-sm dark:text-gray-200 ${temperatureEnabled ? '' : 'opacity-50'}`}
          >
            Temperature
          </span>
          <div className='flex w-full items-center gap-2'>
            <input
              name='temperature'
              type='range'
              min='0'
              max='1'
              step='0.01'
              value={temperature}
              onChange={handleChangeTemperature}
              disabled={!temperatureEnabled}
              className={`h-2 w-full cursor-pointer appearance-none rounded-lg bg-primary-400 accent-primary-800 dark:bg-primary-600 dark:accent-primary-500 ${temperatureEnabled ? '' : 'opacity-50'}`}
            />
            <div className='mr-1 text-gray-900 text-sm dark:text-gray-200'>{temperature.toFixed(2)}</div>
            <ToggleInput value={temperatureEnabled} onClick={handleClickTemperatureEnabled} />
          </div>
        </div>
        <div className='flex items-center justify-between gap-2'>
          <span className='ml-1 w-[110px] font-medium text-gray-900 text-sm dark:text-gray-200'>Max Tokens</span>
          <input
            name='maxTokens'
            type='number'
            min={1}
            max={4096}
            defaultValue={defaultSettings.maxTokens}
            onChange={handleChangeMaxTokens}
            className='w-full rounded-sm border border-gray-300 bg-white px-2 py-1 text-gray-900 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-gray-500'
          />
        </div>
        <ToggleInput label='Markdown Preview' value={markdownPreview} onClick={handleClickShowMarkdownPreview} />
        <ToggleInput label='Stream Mode' value={streamMode} onClick={handleClickStreamMode} />
        <ToggleInput label='Interactive Mode' value={interactiveMode} onClick={handleClickInteractiveMode} />
      </div>
    </div>
  )
}
