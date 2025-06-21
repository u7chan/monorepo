import { useQuery } from '@tanstack/react-query'
import { hc } from 'hono/client'
import { useState } from 'react'

import { ChatLayout } from '#/client/components/chat/ChatLayout'
import { ChatMain } from '#/client/components/chat/ChatMain'
import { ChatSettings } from '#/client/components/chat/ChatSettings'
import {
  type Conversation as ConversationClient,
  ConversationHistory,
} from '#/client/components/chat/ConversationHistory'
import { readFromLocalStorage, type Settings } from '#/client/components/chat/remoteStorageSettings'
import type { AppType } from '#/server/app.d'
import type { Conversation } from '#/types'

const client = hc<AppType>('/')

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

  const { isLoading } = useQuery({
    queryKey: ['todos'],
    queryFn: async () => {
      const res = await client.api.conversations.$get()
      const { data } = await res.json()
      setConversations(data)
      return data
    },
  })

  // 会話履歴の状態管理
  const [conversations, setConversations] = useState<ConversationClient[]>([])
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)

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

  // 会話履歴の操作ハンドラー
  const handleSelectConversation = (conversationId: string) => {
    setCurrentConversationId(conversationId)
    // 選択した会話のメッセージを読み込む処理をここに追加
    // newChatTriggerは新しい会話の時のみ使用するため、ここでは設定しない
  }

  const handleDeleteConversation = (conversationId: string) => {
    setConversations((prev) => prev.filter((conv) => conv.id !== conversationId))
    if (currentConversationId === conversationId) {
      setCurrentConversationId(null)
      setViewModel((p) => ({ ...p, newChatTrigger: Date.now() }))
    }
  }

  const handleNewConversation = () => {
    setCurrentConversationId(null)
    setViewModel((p) => ({ ...p, newChatTrigger: Date.now(), showSettingsPopup: false }))
  }

  // 現在選択されている会話データを取得
  const currentConversation = currentConversationId
    ? conversations.find((conv) => conv.id === currentConversationId) || null
    : null

  // メッセージ更新のハンドラー
  const handleConversationChange = (conversation: Conversation) => {
    client.api.conversations
      .$post({
        json: conversation,
      })
      .then((res) => {
        if (res.status === 200) {
          // TODO: 成功した場合、会話履歴を更新
        }
      })
      .catch((error) => {
        console.error('Error updating conversation:', error)
      })
  }

  return (
    <ChatLayout
      conversations={
        isLoading
          ? 'Loading...'
          : conversations.length > 0 && (
              <ConversationHistory
                conversations={conversations}
                currentConversationId={currentConversationId}
                disabled={!viewModel.showSettingsActions}
                onSelectConversation={handleSelectConversation}
                onDeleteConversation={handleDeleteConversation}
                onNewConversation={handleNewConversation}
              />
            )
      }
    >
      <ChatSettings
        showActions={viewModel.showSettingsActions}
        showNewChat={conversations.length <= 0}
        showPopup={viewModel.showSettingsPopup}
        onNewChat={handleNewChat}
        onShowMenu={handleShowMenu}
        onChange={handleChangeSettings}
        onHidePopup={handleChatClickOutside}
      />
      <ChatMain
        initTrigger={viewModel.newChatTrigger}
        settings={viewModel.settings}
        onSubmitting={handleChatSubmitting}
        currentConversation={currentConversation}
        onConversationChange={handleConversationChange}
      />
    </ChatLayout>
  )
}
