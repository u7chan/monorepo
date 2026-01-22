import type { TextPart, ToolApprovalResponse } from 'ai'
import { useState } from 'react'
import { readStreamableValue } from '@ai-sdk/rsc'

import { AgentConfig } from '@/features/agent-service/agent-config'
import { AgentMessage, agentStream, AssistantMessage, TokenUsage } from '@/features/agent-service/agent-stream-service'
import type { NotifyNewContentOptions } from './use-chat-scroll'

interface UseAgentStreamChatOptions {
  agentConfig: AgentConfig
  onScrollRequest?: (options?: NotifyNewContentOptions) => void
  onResetAutoScroll?: () => void
}

export function useAgentStreamChat({ agentConfig, onScrollRequest, onResetAutoScroll }: UseAgentStreamChatOptions) {
  const [loading, setLoading] = useState(false)
  const [streamMessage, setStreamMessage] = useState('')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | undefined>()
  const [finishReason, setFinishReason] = useState<string | undefined>()
  const [processingTimeMs, setProcessingTimeMs] = useState<number | undefined>()

  const runAgentStream = async (newMessages: AgentMessage[]) => {
    setStreamMessage('')
    setLoading(true)
    setProcessingTimeMs(undefined)
    const { output } = await agentStream(newMessages, agentConfig)
    for await (const stream of readStreamableValue(output)) {
      const {
        delta,
        assistantContent,
        tools,
        usage,
        finishReason,
        processingTimeMs: streamProcessingTimeMs,
      } = stream || {
        delta: '',
        assistantContent: [],
        tools: [],
        usage: undefined,
        finishReason: undefined,
        processingTimeMs: undefined,
      }
      if (delta) {
        setStreamMessage((prev) => prev + delta)
      }
      if (assistantContent && assistantContent.length > 0) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent } as AssistantMessage])
      }
      if (tools && tools.length > 0) {
        setMessages((prev) => [...prev, ...tools])
      }
      if (usage) {
        setTokenUsage(usage)
      }
      if (finishReason) {
        setFinishReason(finishReason)
      }
      if (streamProcessingTimeMs !== undefined) {
        setProcessingTimeMs(streamProcessingTimeMs)
      }
      onScrollRequest?.()
    }
    setStreamMessage('')
    onScrollRequest?.({ force: true })
    setLoading(false)
  }

  const handleSubmit = async (input: string) => {
    const newMessages: AgentMessage[] = [...messages, { role: 'user', content: input }]
    setMessages(newMessages)
    onResetAutoScroll?.()
    await runAgentStream(newMessages)
  }

  const handleToolApproval = async (approvalId: string, approved: boolean) => {
    const approvals: ToolApprovalResponse[] = [
      {
        type: 'tool-approval-response',
        approvalId,
        approved,
      },
    ]
    const newMessages: AgentMessage[] = [...messages, { role: 'tool', content: approvals }]
    setMessages(newMessages)
    onResetAutoScroll?.()
    await runAgentStream(newMessages)
  }

  return {
    loading,
    messages,
    tokenUsage,
    finishReason,
    processingTimeMs,
    streamMessage,
    handleSubmit,
    handleToolApproval,
  }
}
