import { type ChangeEvent, useMemo, useState } from 'react'

import {
  readFromLocalStorage,
  type Settings,
  saveToLocalStorage,
} from '#/client/components/chat/remoteStorageSettings'
import { ToggleInput } from '#/client/components/input/ToggleInput'
import { GearIcon } from '#/client/components/svg/GearIcon'
import { NewChatIcon } from '#/client/components/svg/NewChatIcon'

interface Props {
  onNewChat?: () => void
  onChange?: (settings: Settings) => void
}

export function ChatSettings({ onNewChat, onChange }: Props) {
  const defaultSettings = useMemo(() => {
    return readFromLocalStorage()
  }, [])

  const [model, setModel] = useState(defaultSettings.model)
  const [temperature, setTemperature] = useState<number>(defaultSettings.temperature)
  const [temperatureEnabled, setTemperatureEnabled] = useState(
    defaultSettings?.temperatureEnabled ?? false,
  )
  const [fakeMode, setFakeMode] = useState(defaultSettings?.fakeMode ?? false)
  const [markdownPreview, setMarkdownPreview] = useState(defaultSettings?.markdownPreview ?? true)
  const [streamMode, setStreamMode] = useState(defaultSettings?.streamMode ?? true)
  const [interactiveMode, setInteractiveMode] = useState(defaultSettings?.interactiveMode ?? true)

  const [showMenu, setShowMenu] = useState(false)

  const handleClickNewChat = () => {
    setShowMenu(false)
    onNewChat?.()
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
    const settings = saveToLocalStorage({ temperature: Number.parseFloat(event.target.value) })
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
    const settings = saveToLocalStorage({ temperatureEnabled: newTemperatureEnabled })
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

  return (
    <>
      <div className={'absolute top-2'}>
        <div className='relative top-4 left-4 flex items-center gap-2'>
          <button
            type='button'
            onClick={handleClickNewChat}
            className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400'
          >
            <NewChatIcon className='fill-[#5D5D5D]' />
          </button>
          <button
            type='button'
            onClick={() => setShowMenu(!showMenu)}
            className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400'
          >
            <GearIcon className='fill-[#5D5D5D]' />
          </button>
        </div>
      </div>
      <div
        className={`fixed top-18 left-38 z-10 grid w-[300px] gap-2 rounded border bg-white p-2 opacity-0 shadow-xl transition-opacity duration-100 ease-in ${showMenu ? 'opacity-100' : ''}`}
      >
        <div className='flex items-center justify-between gap-2'>
          <span className={`ml-1 w-[154px] font-medium text-sm ${fakeMode ? 'opacity-50' : ''}`}>
            Model
          </span>
          <input
            name='model'
            defaultValue={model}
            disabled={fakeMode}
            onChange={handleChangeModel}
            placeholder='model'
            className={`w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <div className='flex items-center gap-2'>
          <span className={`ml-1 w-[154px] font-medium text-sm ${fakeMode ? 'opacity-50' : ''}`}>
            BaseURL
          </span>
          <input
            name='baseURL'
            defaultValue={defaultSettings.baseURL || 'https://api.openai.com/v1'}
            disabled={fakeMode}
            onChange={handleChangeBaseURL}
            className={`w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <div className='flex items-center gap-2'>
          <span className={`ml-1 w-[154px] font-medium text-sm ${fakeMode ? 'opacity-50' : ''}`}>
            API KEY
          </span>
          <input
            name='apiKey'
            type='password'
            disabled={fakeMode}
            defaultValue={defaultSettings.apiKey}
            onChange={handleChangeApiKey}
            className={`w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <div className='flex items-center gap-2'>
          <span className={`ml-1 w-[154px] font-medium text-xs ${fakeMode ? 'opacity-50' : ''}`}>
            MCP Server URLs (,)
          </span>
          <input
            name='mcpServerURLs'
            defaultValue={defaultSettings.mcpServerURLs || ''}
            disabled={fakeMode}
            onChange={handleChangeMcpServerURLs}
            className={`w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <ToggleInput label='Fake Mode' value={fakeMode} onClick={handleClickFakeMode} />
        <div className='flex items-center gap-2'>
          <span
            className={`ml-1 w-[154px] font-medium text-sm ${temperatureEnabled ? '' : 'opacity-50'}`}
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
              className={`h-2 w-full cursor-pointer appearance-none rounded-lg bg-primary-400 accent-primary-800 ${temperatureEnabled ? '' : 'opacity-50'}`}
            />
            <div className='mr-1 text-sm'>{temperature.toFixed(2)}</div>
            <ToggleInput value={temperatureEnabled} onClick={handleClickTemperatureEnabled} />
          </div>
        </div>
        <div className='flex items-center justify-between gap-2'>
          <span className='ml-1 w-[154px] font-medium text-sm'>Max Tokens</span>
          <input
            name='maxTokens'
            type='number'
            min={1}
            max={4096}
            defaultValue={defaultSettings.maxTokens}
            onChange={handleChangeMaxTokens}
            className='w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400'
          />
        </div>
        <ToggleInput
          label='Markdown Preview'
          value={markdownPreview}
          onClick={handleClickShowMarkdownPreview}
        />
        <ToggleInput label='Stream Mode' value={streamMode} onClick={handleClickStreamMode} />
        <ToggleInput
          label='Interactive Mode'
          value={interactiveMode}
          onClick={handleClickInteractiveMode}
        />
      </div>
    </>
  )
}
