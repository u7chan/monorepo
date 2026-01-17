'use client'

import { ChatInput } from './chat-input'
import { ChatMessage } from './chat-message'
import { useChat } from './use-chat'

interface ChatProps {
  model: string
  stream?: boolean
}

export function Chat({ model, stream }: ChatProps) {
  const {
    loading,
    messages,
    streamMessage,
    scrollContainer,
    scrollWrapper,
    isNearBottom,
    showJumpButton,
    scrollToBottom,
    updateScrollState,
    handleSubmit,
  } = useChat({ model, stream })

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='relative min-h-0 flex-1'>
        <ChatMessage
          messages={messages}
          streamMessage={streamMessage}
          scrollContainer={scrollContainer}
          scrollWrapper={scrollWrapper}
          onScroll={updateScrollState}
        />
        {showJumpButton && !isNearBottom && (
          <button
            type='button'
            onClick={() => scrollToBottom(true)}
            className='bg-secondary absolute right-4 bottom-4 rounded-full px-3 py-2 text-xs font-medium shadow-md transition hover:opacity-90'
          >
            Jump to latest
          </button>
        )}
      </div>
      <div className='shrink-0'>
        <ChatInput loading={loading} onSubmit={handleSubmit} />
      </div>
    </div>
  )
}
