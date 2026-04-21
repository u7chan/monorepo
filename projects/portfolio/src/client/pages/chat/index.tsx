import { ChatLayout } from '#/client/components/chat/chat-layout'
import { ChatMain } from '#/client/components/chat/chat-main'
import { ChatSettings } from '#/client/components/chat/chat-settings'
import { ConversationHistory } from '#/client/components/chat/conversation-history'
import { SpinnerIcon } from '#/client/components/svg/spinner-icon'
import { useChatPageState } from '#/client/pages/chat/use-chat-page-state'
import { useMetaProps } from '#/client/pages/home'
import type { AppType } from '#/server/app.d'
import { ConversationListResponseSchema, type Conversation } from '#/types'
import { useQuery } from '@tanstack/react-query'
import { hc } from 'hono/client'
import { useState } from 'react'

const client = hc<AppType>('/')

export function Chat() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const {
    selectedConversationId,
    isSettingsPopupOpen,
    isSubmitting,
    newChatTrigger,
    settings,
    showSettingsActions,
    startNewConversation,
    toggleSettingsPopup,
    closeSettingsPopup,
    selectConversation,
    setSubmitting,
    updateSettings,
  } = useChatPageState()

  const { email } = useMetaProps()
  const isAuthenticated = !!email

  const query = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const res = await client.api.conversations.$get()
      const data = ConversationListResponseSchema.parse(await res.json())
      return data.data
    },
    enabled: !!email,
  })

  const conversations = query.data ?? []
  const currentConversation = conversations.find(({ id }) => id === selectedConversationId) || null

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
          if (conversationId === selectedConversationId) {
            startNewConversation()
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
            startNewConversation()
          }
        }
      })
      .catch((error) => {
        console.error('Error updating conversation:', error)
      })
  }

  const handleConversationChange = async (conversation: Conversation): Promise<void> => {
    // カレントの会話IDを更新
    selectConversation(conversation.id)

    if (!email) return

    try {
      const res = await client.api.conversations.$post({ json: conversation })
      if (res.status === 200) {
        // 成功した場合は、会話履歴を再取得
        query.refetch()
      }
    } catch (error) {
      console.error('Error updating conversation:', error)
    }
  }

  return (
    <ChatLayout
      isSidebarOpen={isSidebarOpen}
      onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
      conversations={
        query.isLoading ? (
          <div className='flex h-full flex-col items-center justify-center gap-2'>
            <SpinnerIcon />
            <span className='text-sm text-gray-500 dark:text-gray-400'>Loading...</span>
          </div>
        ) : (
          conversations.length > 0 && (
            <ConversationHistory
              conversations={conversations}
              currentConversationId={selectedConversationId}
              disabled={!showSettingsActions}
              onSelectConversation={selectConversation}
              onDeleteConversation={handleDeleteConversation}
              onNewConversation={startNewConversation}
            />
          )
        )
      }
    >
      <ChatSettings
        showActions={showSettingsActions}
        showNewChat={conversations.length <= 0}
        showPopup={isSettingsPopupOpen}
        showSidebarToggle={!!email}
        isSidebarToggleDisabled={isSubmitting}
        onNewChat={startNewConversation}
        onShowMenu={toggleSettingsPopup}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        onChange={updateSettings}
        onHidePopup={closeSettingsPopup}
      />
      <ChatMain
        initTrigger={newChatTrigger}
        settings={settings}
        canSaveGeneratedFile={isAuthenticated}
        onSubmitting={setSubmitting}
        currentConversation={currentConversation}
        onConversationChange={handleConversationChange}
        onDeleteMessages={handleDeleteConversationMessage}
      />
    </ChatLayout>
  )
}
