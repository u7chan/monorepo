import { useState } from 'react'
import { DeleteIcon } from '#/client/components/svg/DeleteIcon'
import { NewChatIcon } from '#/client/components/svg/NewChatIcon'
import type { Conversation } from '#/types'

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
    <div className='flex h-full flex-col bg-gray-50'>
      <div className='border-gray-200 border-b p-3'>
        <button
          type='button'
          onClick={onNewConversation}
          disabled={disabled}
          className='flex w-full items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 font-medium text-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 enabled:cursor-pointer hover:enabled:bg-gray-50'
        >
          <NewChatIcon className='fill-gray-600' size={16} />
          新しい会話
        </button>
      </div>
      {/* Conversation List */}
      <div className='flex-1 overflow-y-auto'>
        {conversations.length === 0 ? (
          <div className='p-4 text-center text-gray-500 text-sm'>会話履歴がありません</div>
        ) : (
          <div className='p-2'>
            {conversations.map((conversation) => (
              <button
                type='button'
                key={conversation.id}
                className={`group relative mb-1 w-full rounded-md p-3 text-left transition-colors enabled:cursor-pointer ${
                  currentConversationId === conversation.id
                    ? 'border border-primary-200 bg-primary-100'
                    : 'hover:enabled:bg-gray-100'
                }`}
                disabled={disabled}
                onClick={() => onSelectConversation(conversation.id)}
                onMouseEnter={() => setHoveredId(conversation.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className='flex items-start justify-between'>
                  <div className='min-w-0 flex-1'>
                    <h3 className='truncate font-medium text-gray-900 text-sm'>
                      {conversation.title}
                    </h3>
                    <p className='mt-1 text-gray-500 text-xs'>
                      {conversation.messages.length} メッセージ
                    </p>
                  </div>
                  {(hoveredId === conversation.id || currentConversationId === conversation.id) && (
                    <button
                      type='button'
                      onClick={(e) => handleDeleteClick(e, conversation.id)}
                      className='ml-2 p-1 text-gray-400 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100'
                      title='会話を削除'
                    >
                      <DeleteIcon size={14} />
                    </button>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
