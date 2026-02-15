import { ChatLayout } from '#/client/components/chat/chat-layout'
import { ChatMain } from '#/client/components/chat/chat-main'
import { ChatSettings } from '#/client/components/chat/chat-settings'
import { ConversationHistory } from '#/client/components/chat/conversation-history'
import { useMetaProps } from '#/client/pages/home'
import { readFromLocalStorage, type Settings } from '#/client/storage/remote-storage-settings'
import type { AppType } from '#/server/app.d'
import type { Conversation } from '#/types'
import { useQuery } from '@tanstack/react-query'
import { hc } from 'hono/client'
import { useState } from 'react'

const client = hc<AppType>('/')

export function Chat() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  const [viewModel, setViewModel] = useState<{
    showSettingsActions: boolean
    showSettingsPopup: boolean
    newChatTrigger: number
    conversationId: string | null
    conversations: Conversation[]
    settings: Settings
  }>({
    showSettingsActions: true,
    showSettingsPopup: false,
    newChatTrigger: Date.now(),
    conversationId: null,
    conversations: [],
    settings: readFromLocalStorage(),
  })

  const { email } = useMetaProps()

  const query = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const res = await client.api.conversations.$get()
      const { data } = await res.json()
      setViewModel((p) => ({ ...p, conversations: data }))
      return data
    },
  })

  const handleNewChat = () => {
    setViewModel((p) => ({
      ...p,
      newChatTrigger: Date.now(),
      showSettingsPopup: false,
    }))
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

  const handleSelectConversation = (conversationId: string) => {
    setViewModel((p) => ({ ...p, conversationId }))
  }

  const handleDeleteConversation = (conversationId: string) => {
    if (!email) {
      return
    }

    client.api.conversations
      .$delete({
        query: { ids: [conversationId] },
      })
      .then((res) => {
        if (res.status === 200) {
          // 成功した場合は、会話履歴を再取得
          query.refetch()

          // カレントの会話が削除された場合、新しい会話を開始
          if (conversationId === viewModel.conversationId) {
            handleNewConversation()
          }
        }
      })
      .catch((error) => {
        console.error('Error updating conversation:', error)
      })
  }

  const handleDeleteConversationMessage = (messageIds: string[], isConversationEmpty: boolean) => {
    if (!email) {
      return
    }

    client.api.conversations.messages
      .$delete({
        query: { ids: messageIds },
      })
      .then(async (res) => {
        if (res.status === 200) {
          // 成功した場合は、会話履歴を再取得
          query.refetch()

          // カレントの会話が削除された場合、新しい会話を開始
          if (isConversationEmpty) {
            handleNewConversation()
          }
        }
      })
      .catch((error) => {
        console.error('Error updating conversation:', error)
      })
  }

  const handleNewConversation = () => {
    setViewModel((p) => ({
      ...p,
      newChatTrigger: Date.now(),
      showSettingsPopup: false,
      conversationId: null,
    }))
  }

  const handleConversationChange = (conversation: Conversation) => {
    // カレントの会話IDを更新
    setViewModel((p) => ({ ...p, conversationId: conversation.id }))

    if (!email) {
      return
    }

    // サーバーに会話履歴を更新（DB保存用にcontentを文字列化）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = {
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages.map((msg) => ({
        ...msg,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })),
    }
    client.api.conversations
      .$post({
        json: payload,
      })
      .then((res) => {
        if (res.status === 200) {
          // 成功した場合は、会話履歴を再取得
          query.refetch()
        }
      })
      .catch((error) => {
        console.error('Error updating conversation:', error)
      })
  }

  return (
    <ChatLayout
      isSidebarOpen={isSidebarOpen}
      onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
      conversations={
        query.isLoading
          ? 'Loading...'
          : viewModel.conversations.length > 0 && (
              <ConversationHistory
                conversations={viewModel.conversations}
                currentConversationId={viewModel.conversationId}
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
        showNewChat={viewModel.conversations.length <= 0}
        showPopup={viewModel.showSettingsPopup}
        onNewChat={handleNewChat}
        onShowMenu={handleShowMenu}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        onChange={handleChangeSettings}
        onHidePopup={handleChatClickOutside}
      />
      <ChatMain
        initTrigger={viewModel.newChatTrigger}
        settings={viewModel.settings}
        onSubmitting={handleChatSubmitting}
        currentConversation={viewModel.conversations.find(({ id }) => id === viewModel.conversationId) || null}
        onConversationChange={handleConversationChange}
        onDeleteMessages={handleDeleteConversationMessage}
      />
    </ChatLayout>
  )
}
