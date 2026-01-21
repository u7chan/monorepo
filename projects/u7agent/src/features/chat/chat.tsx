'use client'

import { AgentConfig } from '@/features/agent/types'
import { ChatInput } from './chat-input'
import { ChatMessage } from './chat-message'
import { TokenUsageSummary } from './token-usage-summary'
import { useChat } from './use-chat'

interface ChatProps {
  agentConfig: AgentConfig
}

export function Chat({ agentConfig }: ChatProps) {
  const {
    loading,
    messages,
    tokenUsage,
    finishReason,
    streamMessage,
    scrollContainer,
    scrollWrapper,
    isNearBottom,
    showJumpButton,
    scrollToBottom,
    updateScrollState,
    handleSubmit,
  } = useChat({ agentConfig })

  const hasTokenUsage = Boolean(tokenUsage)
  const totalInputTokens = hasTokenUsage
    ? (tokenUsage?.input.noCache ?? 0) + (tokenUsage?.input.cacheRead ?? 0) + (tokenUsage?.input.cacheWrite ?? 0)
    : undefined
  const totalOutputTokens = hasTokenUsage
    ? (tokenUsage?.output.text ?? 0) + (tokenUsage?.output.reasoning ?? 0)
    : undefined
  const inputBreakdown = hasTokenUsage
    ? [
        ['No cache', tokenUsage?.input.noCache],
        ['Cache read', tokenUsage?.input.cacheRead],
        ['Cache write', tokenUsage?.input.cacheWrite],
      ]
    : []
  const outputBreakdown = hasTokenUsage
    ? [
        ['Text', tokenUsage?.output.text],
        ['Reasoning', tokenUsage?.output.reasoning],
      ]
    : []

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
        <TokenUsageSummary tokenUsage={tokenUsage} finishReason={finishReason} />
        <ChatInput loading={loading} onSubmit={handleSubmit} />
      </div>
    </div>
  )
}
