import { useCallback, useEffect, useRef, useState } from 'react'
import {
  readFromLocalStorage,
  saveToLocalStorage,
  type Settings,
} from '#/client/shared/storage/remote-storage-settings'
import type { ChatError } from '#/types/chat-api'

export function useChatPageState(selectedConversationId: string | null) {
  const [isSettingsPopupOpen, setIsSettingsPopupOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [newChatTrigger, setNewChatTrigger] = useState(Date.now())
  const [settings, setSettings] = useState<Settings>(() => readFromLocalStorage())
  const [settingsError, setSettingsError] = useState<ChatError | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => readFromLocalStorage().sidebarOpen)
  const previousConversationIdRef = useRef<string | null>(selectedConversationId)

  useEffect(() => {
    if (previousConversationIdRef.current !== null && selectedConversationId === null) {
      setIsSettingsPopupOpen(false)
      setSettingsError(null)
      setNewChatTrigger(Date.now())
    }

    previousConversationIdRef.current = selectedConversationId
  }, [selectedConversationId])

  const startNewConversation = useCallback(() => {
    setIsSettingsPopupOpen(false)
    setSettingsError(null)
    setNewChatTrigger(Date.now())
  }, [])

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen((current) => {
      const next = !current
      saveToLocalStorage({ sidebarOpen: next })
      return next
    })
  }, [])

  const toggleSettingsPopup = useCallback(() => {
    setIsSettingsPopupOpen((current) => !current)
  }, [])

  const closeSettingsPopup = useCallback(() => {
    setIsSettingsPopupOpen(false)
  }, [])

  const setSubmitting = useCallback((submitting: boolean) => {
    setIsSubmitting(submitting)
  }, [])

  const updateSettings = useCallback((nextSettings: Settings) => {
    setSettingsError(null)
    setSettings(nextSettings)
  }, [])

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettingsError(null)
    const nextSettings = saveToLocalStorage({ [key]: value })
    setSettings(nextSettings)
    return nextSettings
  }, [])

  const showSettingsError = useCallback((error: ChatError) => {
    setSettingsError(error)
    setIsSettingsPopupOpen(true)
  }, [])

  return {
    selectedConversationId,
    isSettingsPopupOpen,
    isSubmitting,
    isSidebarOpen,
    newChatTrigger,
    settings,
    settingsError,
    showSettingsActions: !isSubmitting,
    startNewConversation,
    toggleSidebar,
    toggleSettingsPopup,
    closeSettingsPopup,
    setSubmitting,
    updateSettings,
    updateSetting,
    showSettingsError,
  }
}
