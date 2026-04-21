import { DeleteIcon } from '#/client/components/svg/delete-icon'
import { MessageIcon } from '#/client/components/svg/message-icon'
import { NewChatIcon } from '#/client/components/svg/new-chat-icon'
import type { Conversation } from '#/types'
import { useState } from 'react'

const conversationDateFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

interface Props {
  conversations: Conversation[]
  currentConversationId: string | null
  disabled?: boolean
  onSelectConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onNewConversation: () => void
}

function getConversationDateLabel(conversation: Conversation) {
  if (!conversation.updatedAt) {
    return null
  }

  return conversationDateFormatter.format(conversation.updatedAt)
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
      <div className='flex h-12 items-center border-gray-200 border-b px-3 dark:border-gray-700'>
        <button
          type='button'
          onClick={onNewConversation}
          disabled={disabled}
          className='flex w-full items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:enabled:bg-gray-600'
        >
          <NewChatIcon className='fill-[#5D5D5D] dark:fill-gray-300' size={16} />
          新しい会話
        </button>
      </div>
      {/* Conversation List */}
      <div className='flex-1 overflow-y-auto'>
        {conversations.length === 0 ? (
          <div className='p-4 text-center text-gray-500 text-sm dark:text-gray-400'>会話履歴がありません</div>
        ) : (
          <div className='p-2'>
            {conversations.map((conversation, index) => {
              const nextConversation = conversations[index + 1]
              const shouldShowDivider =
                index < conversations.length - 1 &&
                hoveredId !== conversation.id &&
                currentConversationId !== conversation.id &&
                hoveredId !== nextConversation?.id &&
                currentConversationId !== nextConversation?.id

              return (
                <div key={conversation.id}>
                  <div
                    className={`group relative w-full rounded-md p-3 text-left transition-colors ${
                      currentConversationId === conversation.id
                        ? 'border border-primary-200 bg-primary-100 dark:border-primary-600 dark:bg-primary-900/30'
                        : 'hover:bg-gray-100/90 dark:hover:bg-gray-700/80'
                    } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                    onMouseEnter={() => setHoveredId(conversation.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <div
                      role='button'
                      tabIndex={disabled ? -1 : 0}
                      className='flex items-center justify-between pr-8'
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
                        <div className='mt-1 flex items-center gap-2 text-gray-500 text-xs dark:text-gray-400'>
                          <span className='inline-flex shrink-0 items-center gap-1 tabular-nums'>
                            <MessageIcon size={12} className='stroke-gray-400 dark:stroke-gray-500' />
                            <span>{conversation.messages.length}</span>
                          </span>
                          {getConversationDateLabel(conversation) && (
                            <>
                              <span className='h-px min-w-2 flex-1 bg-gray-300 dark:bg-gray-600' />
                              <span className='shrink-0 tabular-nums'>{getConversationDateLabel(conversation)}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    {!disabled && (
                      <button
                        type='button'
                        onClick={(e) => handleDeleteClick(e, conversation.id)}
                        className={`absolute right-3 top-1/2 ml-2 -translate-y-1/2 rounded-md p-1 text-gray-400 opacity-100 transition-[opacity,background-color,color] hover:bg-red-50 hover:text-red-500 md:opacity-0 md:group-hover:opacity-100 dark:text-gray-500 dark:hover:bg-red-500/10 dark:hover:text-red-400 ${
                          currentConversationId === conversation.id ? 'md:opacity-100' : ''
                        }`}
                        title='会話を削除'
                      >
                        <DeleteIcon size={14} className='stroke-current' />
                      </button>
                    )}
                  </div>
                  {index < conversations.length - 1 && (
                    <div
                      className={`mx-3 h-px bg-gray-200 transition-opacity dark:bg-gray-700 ${
                        shouldShowDivider ? 'opacity-100' : 'opacity-0'
                      }`}
                      aria-hidden='true'
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
