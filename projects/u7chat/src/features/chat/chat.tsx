'use client'

import { ChatInput } from './chat-input'
import { ChatMessage } from './chat-message'
import { useChat } from './use-chat'

interface ChatProps {
  model: string
  stream?: boolean
}

export function Chat({ model, stream }: ChatProps) {
  const { loading, messages, streamMessage, scrollContainer, handleSubmit } = useChat({ model, stream })

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='min-h-0 flex-1'>
        <ChatMessage messages={messages} streamMessage={streamMessage} scrollContainer={scrollContainer} />
      </div>
      <div className='shrink-0'>
        <ChatInput loading={loading} onSubmit={handleSubmit} />
      </div>
    </div>
  )
}
