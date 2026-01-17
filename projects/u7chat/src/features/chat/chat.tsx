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
    <>
      <ChatMessage messages={messages} streamMessage={streamMessage} scrollContainer={scrollContainer} />
      <ChatInput loading={loading} onSubmit={handleSubmit} />
    </>
  )
}
