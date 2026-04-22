import type { Settings } from '#/client/storage/remote-storage-settings'
import type { ApiMode } from '#/types'
import { createContext, type ChangeEvent, type ReactNode, useContext } from 'react'

type ReasoningEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ChatSettingsContextValue {
  settings: Settings
  temperature: number
  temperatureEnabled: boolean
  autoModel: boolean
  apiMode: ApiMode
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  reasoningEffort: ReasoningEffortLevel
  reasoningEffortEnabled: boolean
  fetchedModels: string[]
  isLoadingModels: boolean
  fetchError: string | null
  refetchModels: () => void
  handleChangeAutoModel: (event: ChangeEvent<HTMLSelectElement>) => void
  handleChangeManualModel: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeBaseURL: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeApiKey: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeApiMode: (event: ChangeEvent<HTMLSelectElement>) => void
  handleChangeTemperature: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeMaxTokens: (event: ChangeEvent<HTMLInputElement>) => void
  handleChangeReasoningEffort: (event: ChangeEvent<HTMLSelectElement>) => void
  handleToggleTemperature: () => void
  handleToggleAutoModel: () => void
  handleToggleFakeMode: () => void
  handleToggleMarkdownPreview: () => void
  handleToggleStreamMode: () => void
  handleToggleInteractiveMode: () => void
  handleToggleReasoningEffort: () => void
}

const ChatSettingsContext = createContext<ChatSettingsContextValue | null>(null)

export function useChatSettingsContext(): ChatSettingsContextValue {
  const context = useContext(ChatSettingsContext)
  if (!context) {
    throw new Error('useChatSettingsContext must be used within a ChatSettingsProvider')
  }
  return context
}

interface ChatSettingsProviderProps {
  value: ChatSettingsContextValue
  children: ReactNode
}

export function ChatSettingsProvider({ value, children }: ChatSettingsProviderProps) {
  return <ChatSettingsContext.Provider value={value}>{children}</ChatSettingsContext.Provider>
}
