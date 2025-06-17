import { useState } from 'react'
import { ChatMain } from '#/client/components/chat/ChatMain'
import { ChatSettings } from '#/client/components/chat/ChatSettings'
import { readFromLocalStorage, type Settings } from '#/client/components/chat/remoteStorageSettings'

export function Chat() {
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<Settings>(readFromLocalStorage())

  const handleNewChat = () => {
    setShowSettings(false)
  }

  const handleShowMenu = () => {
    setShowSettings(true)
  }

  const handleChangeSettings = (settings: Settings) => {
    setSettings(settings)
  }

  const handleClickOutside = () => {
    setShowSettings(false)
  }

  return (
    <>
      <ChatSettings
        show={showSettings}
        onNewChat={handleNewChat}
        onShowMenu={handleShowMenu}
        onChange={handleChangeSettings}
      />
      <ChatMain settings={settings} onClickOutside={handleClickOutside} />
    </>
  )
}
