import { useState } from 'react'
import { ChatMain } from '#/client/components/chat/ChatMain'
import { ChatSettings } from '#/client/components/chat/ChatSettings'
import { readFromLocalStorage, type Settings } from '#/client/components/chat/remoteStorageSettings'

export function Chat() {
  const [settings, setSettings] = useState<Settings>(readFromLocalStorage())
  const handleChangeSettings = (settings: Settings) => {
    setSettings(settings)
  }
  return (
    <>
      <ChatSettings onChange={handleChangeSettings} />
      <ChatMain settings={settings} />
    </>
  )
}
