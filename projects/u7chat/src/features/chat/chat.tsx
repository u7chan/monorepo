'use client'

import { ChatInput } from './chat-input'
import { ChatMessage } from './chat-message'
import { useChat } from './use-chat'

interface ChatProps {
  model: string
  stream?: boolean
}

export function Chat({ model, stream }: ChatProps) {
  const { loading, inputText, outputText, scrollContainer, handleSubmit } = useChat({ model, stream })

  return (
    <>
      <ChatMessage user={inputText} assistant={outputText} scrollContainer={scrollContainer} />
      <ChatInput loading={loading} onSubmit={handleSubmit} />
    </>
  )
}
