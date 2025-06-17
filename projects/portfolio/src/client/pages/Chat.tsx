import { useState } from 'react'
import { ChatMain } from '#/client/components/chat/ChatMain'
import { ChatSettings } from '#/client/components/chat/ChatSettings'
import { readFromLocalStorage, type Settings } from '#/client/components/chat/remoteStorageSettings'

export function Chat() {
  const [viewModel, setViewModel] = useState<{
    showSettingsActions: boolean
    showSettingsPopup: boolean
    settings: Settings
  }>({
    showSettingsActions: true,
    showSettingsPopup: false,
    settings: readFromLocalStorage(),
  })

  const handleNewChat = () => {
    setViewModel((p) => ({ ...p, showSettingsPopup: false }))
  }

  const handleShowMenu = () => {
    setViewModel((p) => ({ ...p, showSettingsPopup: true }))
  }

  const handleChangeSettings = (settings: Settings) => {
    setViewModel((p) => ({ ...p, settings }))
  }

  const handleChatClickOutside = () => {
    setViewModel((p) => ({ ...p, showSettingsPopup: false }))
  }

  const handleChatSubmitting = (submitting: boolean) => {
    setViewModel((p) => ({ ...p, showSettingsActions: !submitting }))
  }

  return (
    <>
      <ChatSettings
        showActions={viewModel.showSettingsActions}
        showPopup={viewModel.showSettingsPopup}
        onNewChat={handleNewChat}
        onShowMenu={handleShowMenu}
        onChange={handleChangeSettings}
      />
      <ChatMain
        settings={viewModel.settings}
        onClickOutside={handleChatClickOutside}
        onSubmitting={handleChatSubmitting}
      />
    </>
  )
}
