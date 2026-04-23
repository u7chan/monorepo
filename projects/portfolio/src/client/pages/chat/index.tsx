import { ChatLayout } from '#/client/components/chat/chat-layout'
import { ChatMain } from '#/client/components/chat/chat-main'
import { ChatSettings } from '#/client/components/chat/chat-settings'
import { ConversationHistory } from '#/client/components/chat/conversation-history'
import { SpinnerIcon } from '#/client/components/svg/spinner-icon'
import { useChatPageState } from '#/client/pages/chat/use-chat-page-state'
import { useMetaProps } from '#/client/pages/home'
import { Route } from '#/client/routes/chat'
import type { AppType } from '#/server/app.d'
import { ConversationListResponseSchema, type Conversation } from '#/types'
import { useQuery } from '@tanstack/react-query'
import { hc } from 'hono/client'
import { useCallback, useEffect } from 'react'

const client = hc<AppType>('/')

export function Chat() {
  const { conversationId } = Route.useSearch()
  const navigate = Route.useNavigate()
  const {
    selectedConversationId,
    isSettingsPopupOpen,
    isSubmitting,
    isSidebarOpen,
    newChatTrigger,
    settings,
    showSettingsActions,
    startNewConversation,
    toggleSidebar,
    toggleSettingsPopup,
    closeSettingsPopup,
    setSubmitting,
    updateSettings,
  } = useChatPageState(conversationId ?? null)

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
  const isResolvingConversation = selectedConversationId !== null && currentConversation === null
  const navigateToNewConversation = useCallback(() => {
    startNewConversation()
    void navigate({
      to: '/chat',
      search: { conversationId: undefined },
    })
  }, [navigate, startNewConversation])

  const navigateToConversation = useCallback(
    (nextConversationId: string, replace = false) => {
      void navigate({
        to: '/chat',
        search: { conversationId: nextConversationId },
        replace,
      })
    },
    [navigate]
  )

  useEffect(() => {
    if (!selectedConversationId) {
      return
    }

    if (!isAuthenticated) {
      void navigate({
        to: '/chat',
        search: { conversationId: undefined },
        replace: true,
      })
      return
    }

    if (query.isLoading) {
      return
    }

    if (conversations.some(({ id }) => id === selectedConversationId)) {
      return
    }

    void navigate({
      to: '/chat',
      search: { conversationId: undefined },
      replace: true,
    })
  }, [conversations, isAuthenticated, navigate, query.isLoading, selectedConversationId])

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
            navigateToNewConversation()
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
            navigateToNewConversation()
          }
        }
      })
      .catch((error) => {
        console.error('Error updating conversation:', error)
      })
  }

  const handleConversationChange = async (conversation: Conversation): Promise<void> => {
    const shouldReplace = !selectedConversationId
    if (!email) return

    try {
      const res = await client.api.conversations.$post({ json: conversation })
      if (res.status === 200) {
        // 成功した場合は、会話履歴を再取得
        const refetched = await query.refetch()

        if (
          conversation.id !== selectedConversationId &&
          (refetched.data ?? []).some(({ id }) => id === conversation.id)
        ) {
          navigateToConversation(conversation.id, shouldReplace)
        }
      }
    } catch (error) {
      console.error('Error updating conversation:', error)
    }
  }

  return (
    <ChatLayout
      isSidebarOpen={isSidebarOpen}
      onToggleSidebar={toggleSidebar}
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
              onSelectConversation={(nextConversationId) => {
                navigateToConversation(nextConversationId)
              }}
              onDeleteConversation={handleDeleteConversation}
              onNewConversation={navigateToNewConversation}
            />
          )
        )
      }
    >
      <ChatSettings
        showActions={showSettingsActions}
        showNewChat={(!query.isLoading && conversations.length <= 0) || !isSidebarOpen}
        showPopup={isSettingsPopupOpen}
        showSidebarToggle={!!email}
        isSidebarOpen={isSidebarOpen}
        isSidebarToggleDisabled={isSubmitting}
        onNewChat={navigateToNewConversation}
        onShowMenu={toggleSettingsPopup}
        onToggleSidebar={toggleSidebar}
        onChange={updateSettings}
        onHidePopup={closeSettingsPopup}
      />
      {isResolvingConversation ? (
        <div className='flex min-h-0 flex-1 items-center justify-center gap-2'>
          <SpinnerIcon />
          <span className='text-sm text-gray-500 dark:text-gray-400'>会話を読み込み中...</span>
        </div>
      ) : (
        <ChatMain
          initTrigger={newChatTrigger}
          settings={settings}
          canSaveGeneratedFile={isAuthenticated}
          onSubmitting={setSubmitting}
          currentConversation={currentConversation}
          onConversationChange={handleConversationChange}
          onDeleteMessages={handleDeleteConversationMessage}
        />
      )}
    </ChatLayout>
  )
}
