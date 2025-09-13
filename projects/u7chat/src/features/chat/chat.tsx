'use client'

import { ChatInput } from './chat-input'
import { ChatMessage } from './chat-message'
import { useChat } from './use-chat'

interface ChatProps {
  model: string
}

export function Chat({ model }: ChatProps) {
  const { loading, inputText, streamText, scrollContainer, handleSubmit } = useChat(model)

  return (
    <>
      <ChatMessage user={inputText} assistant={streamText} scrollContainer={scrollContainer} />
      <ChatInput loading={loading} onSubmit={handleSubmit} />
    </>
  )
}
