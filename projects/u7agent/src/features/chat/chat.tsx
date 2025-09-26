'use client'

import { AgentConfig } from '@/features/agent/types'
import { ChatInput } from './chat-input'
import { ChatMessage } from './chat-message'
import { useChat } from './use-chat'

interface ChatProps {
  agentConfig: AgentConfig
}

export function Chat({ agentConfig }: ChatProps) {
  const { loading, inputText, outputText, scrollContainer, handleSubmit } = useChat({ agentConfig })

  return (
    <>
      <ChatMessage user={inputText} assistant={outputText} scrollContainer={scrollContainer} />
      <ChatInput loading={loading} onSubmit={handleSubmit} />
    </>
  )
}
