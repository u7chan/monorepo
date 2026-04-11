import { readFromLocalStorage, type Settings } from '#/client/storage/remote-storage-settings'
import { useCallback, useState } from 'react'

export function useChatPageState() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [isSettingsPopupOpen, setIsSettingsPopupOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [newChatTrigger, setNewChatTrigger] = useState(Date.now())
  const [settings, setSettings] = useState<Settings>(() => readFromLocalStorage())

  const startNewConversation = useCallback(() => {
    setSelectedConversationId(null)
    setIsSettingsPopupOpen(false)
    setNewChatTrigger(Date.now())
  }, [])

  const toggleSettingsPopup = useCallback(() => {
    setIsSettingsPopupOpen((current) => !current)
  }, [])

  const closeSettingsPopup = useCallback(() => {
    setIsSettingsPopupOpen(false)
  }, [])

  const selectConversation = useCallback((conversationId: string) => {
    setSelectedConversationId(conversationId)
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
    newChatTrigger,
    settings,
    showSettingsActions: !isSubmitting,
    startNewConversation,
    toggleSettingsPopup,
    closeSettingsPopup,
    selectConversation,
    setSubmitting,
    updateSettings,
  }
}
