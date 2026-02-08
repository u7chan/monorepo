'use client'

import { useMemo } from 'react'

import { AgentConfig } from '@/features/agent-service/agent-config'
import { ChatInput } from './chat-input'
import { ChatMessage } from './chat-message'
import { DebugMessagesOverlay } from './debug-messages-overlay'
import { JumpToLatestButton } from './jump-to-latest-button'
import { ModelRunSummary } from './token-usage-summary'
import { useAgentStreamChat } from './use-agent-stream-chat'
import { useChatScroll } from './use-chat-scroll'
import { env } from '@/env'

interface ChatProps {
  agentConfig: AgentConfig
}

export function Chat({ agentConfig }: ChatProps) {
  const scroll = useChatScroll()
  const {
    loading,
    messages,
    tokenUsage,
    finishReason,
    processingTimeMs,
    streamMessage,
    handleSubmit,
    handleToolApproval,
  } = useAgentStreamChat({
    agentConfig,
    onScrollRequest: scroll.notifyNewContent,
    onResetAutoScroll: scroll.resetAutoScroll,
  })

  const { scrollContainer, scrollWrapper, isNearBottom, showJumpButton, scrollToBottom, updateScrollState } = scroll
  const isDebug = env.NEXT_PUBLIC_DEBUG?.toLowerCase() === 'true'

  const debugMessages = useMemo(() => {
    if (!isDebug) {
      return ''
    }
    return JSON.stringify(messages, null, 2)
  }, [isDebug, messages])
  const messageCount = messages.length

  return (
    <>
      <div className='flex min-h-0 flex-1 flex-col'>
        <div className='relative min-h-0 flex-1'>
          <ChatMessage
            messages={messages}
            streamMessage={streamMessage}
            scrollContainer={scrollContainer}
            scrollWrapper={scrollWrapper}
            onScroll={updateScrollState}
            onToolApproval={handleToolApproval}
          />
          <JumpToLatestButton
            showJumpButton={showJumpButton}
            isNearBottom={isNearBottom}
            onClick={() => scrollToBottom(true)}
          />
        </div>
        <div className='shrink-0'>
          <ModelRunSummary usage={tokenUsage} finishReason={finishReason} processingTimeMs={processingTimeMs} />
          <ChatInput loading={loading} onSubmit={handleSubmit} />
        </div>
      </div>
      {isDebug && <DebugMessagesOverlay messagesJson={debugMessages} messageCount={messageCount} />}
    </>
  )
}
