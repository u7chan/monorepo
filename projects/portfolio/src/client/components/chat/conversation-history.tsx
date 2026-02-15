import { DeleteIcon } from '#/client/components/svg/delete-icon'
import { NewChatIcon } from '#/client/components/svg/new-chat-icon'
import type { Conversation } from '#/types'
import { useState } from 'react'

interface Props {
  conversations: Conversation[]
  currentConversationId: string | null
  disabled?: boolean
  onSelectConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onNewConversation: () => void
}

export function ConversationHistory({
  conversations,
  currentConversationId,
  disabled,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const handleDeleteClick = (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation()
    if (confirm('この会話を削除しますか？')) {
      onDeleteConversation(conversationId)
    }
  }

  return (
    <div className='flex h-full flex-col bg-gray-50 dark:bg-gray-800'>
      <div className='border-gray-200 border-b p-3 dark:border-gray-700'>
        <button
          type='button'
          onClick={onNewConversation}
          disabled={disabled}
          className='flex w-full items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 font-medium text-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 enabled:cursor-pointer hover:enabled:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:enabled:bg-gray-600'
        >
          <NewChatIcon className='fill-gray-600 dark:fill-gray-400' size={16} />
          新しい会話
        </button>
      </div>
      {/* Conversation List */}
      <div className='flex-1 overflow-y-auto'>
        {conversations.length === 0 ? (
          <div className='p-4 text-center text-gray-500 text-sm dark:text-gray-400'>会話履歴がありません</div>
        ) : (
          <div className='p-2'>
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`group relative mb-1 w-full rounded-md p-3 text-left transition-colors ${
                  currentConversationId === conversation.id
                    ? 'border border-primary-200 bg-primary-100 dark:border-primary-600 dark:bg-primary-900/30'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                onMouseEnter={() => setHoveredId(conversation.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div
                  role='button'
                  tabIndex={disabled ? -1 : 0}
                  className='flex items-start justify-between'
                  onClick={() => !disabled && onSelectConversation(conversation.id)}
                  onKeyDown={(e) => {
                    if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      onSelectConversation(conversation.id)
                    }
                  }}
                >
                  <div className='min-w-0 flex-1'>
                    <h3 className='truncate font-medium text-gray-900 text-sm dark:text-gray-100'>
                      {conversation.title}
                    </h3>
                    <p className='mt-1 text-gray-500 text-xs dark:text-gray-400'>
                      {conversation.messages.length} メッセージ
                    </p>
                  </div>
                </div>
                {(hoveredId === conversation.id || currentConversationId === conversation.id) && !disabled && (
                  <button
                    type='button'
                    onClick={(e) => handleDeleteClick(e, conversation.id)}
                    className='absolute right-3 top-3 ml-2 p-1 text-gray-400 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 dark:text-gray-500 dark:hover:text-red-400'
                    title='会話を削除'
                  >
                    <DeleteIcon size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
