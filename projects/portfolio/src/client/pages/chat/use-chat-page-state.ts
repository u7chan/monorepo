import { readFromLocalStorage, saveToLocalStorage, type Settings } from '#/client/storage/remote-storage-settings'
import { useCallback, useEffect, useRef, useState } from 'react'

export function useChatPageState(selectedConversationId: string | null) {
  const [isSettingsPopupOpen, setIsSettingsPopupOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [newChatTrigger, setNewChatTrigger] = useState(Date.now())
  const [settings, setSettings] = useState<Settings>(() => readFromLocalStorage())
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => readFromLocalStorage().sidebarOpen)
  const previousConversationIdRef = useRef<string | null>(selectedConversationId)

  useEffect(() => {
    if (previousConversationIdRef.current !== null && selectedConversationId === null) {
      setIsSettingsPopupOpen(false)
      setNewChatTrigger(Date.now())
    }

    previousConversationIdRef.current = selectedConversationId
  }, [selectedConversationId])

  const startNewConversation = useCallback(() => {
    setIsSettingsPopupOpen(false)
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
    setSettings(nextSettings)
  }, [])

  return {
    selectedConversationId,
    isSettingsPopupOpen,
    isSubmitting,
    isSidebarOpen,
    newChatTrigger,
    settings,
    showSettingsActions: !isSubmitting,
    startNewConversation,
    toggleSidebar,
    toggleSettingsPopup,
    closeSettingsPopup,
    setSubmitting,
    updateSettings,
  }
}
