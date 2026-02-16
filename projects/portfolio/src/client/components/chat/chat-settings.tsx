import { GearIcon } from '#/client/components/svg/gear-icon'
import { NewChatIcon } from '#/client/components/svg/new-chat-icon'
import { SidebarIcon } from '#/client/components/svg/sidebar-icon'
import { readFromLocalStorage, type Settings, saveToLocalStorage } from '#/client/storage/remote-storage-settings'
import type { AppType } from '#/server/app'
import { hc } from 'hono/client'
import { type ChangeEvent, useEffect, useMemo, useState } from 'react'
import { ChatSettingsForm } from './chat-settings/chat-settings-form'
import { ChatSettingsPanel } from './chat-settings/chat-settings-panel'

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

  const handleChangeManualModel = (event: ChangeEvent<HTMLInputElement>) => {
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

  const handleToggleTemperature = () => {
    const newTemperatureEnabled = !temperatureEnabled
    setTemperatureEnabled(newTemperatureEnabled)
    const settings = saveToLocalStorage({
      temperatureEnabled: newTemperatureEnabled,
    })
    onChange?.(settings)
  }

  const handleToggleAutoModel = () => {
    const newAutoModel = !autoModel
    setAutoModel(newAutoModel)
    const settings = saveToLocalStorage({ autoModel: newAutoModel })
    onChange?.(settings)
  }

  const handleToggleFakeMode = () => {
    const newFakeMode = !fakeMode
    setFakeMode(newFakeMode)
    const settings = saveToLocalStorage({ fakeMode: newFakeMode })
    onChange?.(settings)
  }

  const handleToggleMarkdownPreview = () => {
    const newMarkdownPreview = !markdownPreview
    setMarkdownPreview(newMarkdownPreview)
    const settings = saveToLocalStorage({ markdownPreview: newMarkdownPreview })
    onChange?.(settings)
  }

  const handleToggleStreamMode = () => {
    const newStreamMode = !streamMode
    setStreamMode(newStreamMode)
    const settings = saveToLocalStorage({ streamMode: newStreamMode })
    onChange?.(settings)
  }

  const handleToggleInteractiveMode = () => {
    const newInteractiveMode = !interactiveMode
    setInteractiveMode(newInteractiveMode)
    const settings = saveToLocalStorage({ interactiveMode: newInteractiveMode })
    onChange?.(settings)
  }

  const handleToggleReasoningEffort = () => {
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
                className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 md:hidden dark:bg-gray-800 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
              >
                <SidebarIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
              </button>
            )}
            {showNewChat && (
              <button
                type='button'
                onClick={handleClickNewChat}
                className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-gray-800 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
              >
                <NewChatIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
              </button>
            )}
            <button
              type='button'
              onClick={handleClickShowMenu}
              className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-gray-800 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
            >
              <GearIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
            </button>
            <span className='hidden max-w-48 truncate text-xs font-medium text-gray-900 sm:block dark:text-gray-200'>
              {fakeMode ? 'Fake Mode' : model}
            </span>
          </div>
        )}
      </div>

      {/* Settings Panel */}
      <ChatSettingsPanel show={showPopup ?? false} onClose={onHidePopup ?? (() => {})}>
        <ChatSettingsForm
          settings={defaultSettings}
          fetchedModels={fetchedModels}
          temperature={temperature}
          temperatureEnabled={temperatureEnabled}
          autoModel={autoModel}
          fakeMode={fakeMode}
          markdownPreview={markdownPreview}
          streamMode={streamMode}
          interactiveMode={interactiveMode}
          reasoningEffort={reasoningEffort}
          reasoningEffortEnabled={reasoningEffortEnabled}
          onChangeAutoModel={handleChangeAutoModel}
          onChangeManualModel={handleChangeManualModel}
          onChangeBaseURL={handleChangeBaseURL}
          onChangeApiKey={handleChangeApiKey}
          onChangeMcpServerURLs={handleChangeMcpServerURLs}
          onChangeTemperature={handleChangeTemperature}
          onChangeMaxTokens={handleChangeMaxTokens}
          onToggleTemperature={handleToggleTemperature}
          onToggleAutoModel={handleToggleAutoModel}
          onToggleFakeMode={handleToggleFakeMode}
          onToggleMarkdownPreview={handleToggleMarkdownPreview}
          onToggleStreamMode={handleToggleStreamMode}
          onToggleInteractiveMode={handleToggleInteractiveMode}
          onToggleReasoningEffort={handleToggleReasoningEffort}
          onChangeReasoningEffort={handleChangeReasoningEffort}
        />
      </ChatSettingsPanel>
    </>
  )
}
