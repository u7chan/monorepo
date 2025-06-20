import { useState } from 'react'

import { ChatMain } from '#/client/components/chat/ChatMain'
import { ChatSettings } from '#/client/components/chat/ChatSettings'
import { readFromLocalStorage, type Settings } from '#/client/components/chat/remoteStorageSettings'
import { ChatLayout } from '#/client/components/chat/ChatLayout'

export function Chat() {
  const [viewModel, setViewModel] = useState<{
    showSettingsActions: boolean
    showSettingsPopup: boolean
    newChatTrigger: number
    settings: Settings
  }>({
    showSettingsActions: true,
    showSettingsPopup: false,
    newChatTrigger: Date.now(),
    settings: readFromLocalStorage(),
  })

  const handleNewChat = () => {
    setViewModel((p) => ({ ...p, newChatTrigger: Date.now(), showSettingsPopup: false }))
  }

  const handleShowMenu = () => {
    setViewModel((p) => ({ ...p, showSettingsPopup: !p.showSettingsPopup }))
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

  const showConversations = false

  return (
    <ChatLayout conversations={showConversations && <div>会話履歴</div>}>
      <ChatSettings
        showActions={viewModel.showSettingsActions}
        showPopup={viewModel.showSettingsPopup}
        onNewChat={handleNewChat}
        onShowMenu={handleShowMenu}
        onChange={handleChangeSettings}
      />
      <ChatMain
        initTrigger={viewModel.newChatTrigger}
        settings={viewModel.settings}
        onClickOutside={handleChatClickOutside}
        onSubmitting={handleChatSubmitting}
      />
    </ChatLayout>
  )
}
