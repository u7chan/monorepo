import type { ToolApprovalResponse } from 'ai'
import { useState } from 'react'
import { readStreamableValue } from '@ai-sdk/rsc'

import { AgentConfig } from '@/features/agent-service/agent-config'
import { AgentMessage, agentStream, AssistantMessage, ModelUsage } from '@/features/agent-service/agent-stream-service'
import type { NotifyNewContentOptions } from './use-chat-scroll'

interface UseAgentStreamChatOptions {
  agentConfig: AgentConfig
  onScrollRequest?: (options?: NotifyNewContentOptions) => void
  onResetAutoScroll?: () => void
}

interface StreamStateMeta {
  tokenUsage?: ModelUsage
  finishReason?: string
  processingTimeMs?: number
}

export function useAgentStreamChat({ agentConfig, onScrollRequest, onResetAutoScroll }: UseAgentStreamChatOptions) {
  const [loading, setLoading] = useState(false)
  const [streamMessage, setStreamMessage] = useState('')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streamMeta, setStreamMeta] = useState<StreamStateMeta>({
    tokenUsage: undefined,
    finishReason: undefined,
    processingTimeMs: undefined,
  })
  const { tokenUsage, finishReason, processingTimeMs } = streamMeta

  const runAgentStream = async (newMessages: AgentMessage[]) => {
    setStreamMessage('')
    setLoading(true)
    setStreamMeta((prev) => ({ ...prev, processingTimeMs: undefined }))
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
      const messageUpdates: AgentMessage[] = []
      if (assistantContent && assistantContent.length > 0) {
        messageUpdates.push({ role: 'assistant', content: assistantContent } as AssistantMessage)
      }
      if (tools && tools.length > 0) {
        messageUpdates.push(...tools)
      }
      if (messageUpdates.length > 0) {
        setMessages((prev) => [...prev, ...messageUpdates])
      }
      const metaUpdates: Partial<StreamStateMeta> = {}
      if (usage) {
        metaUpdates.tokenUsage = usage
      }
      if (finishReason) {
        metaUpdates.finishReason = finishReason
      }
      if (streamProcessingTimeMs !== undefined) {
        metaUpdates.processingTimeMs = streamProcessingTimeMs
      }
      if (Object.keys(metaUpdates).length > 0) {
        setStreamMeta((prev) => ({ ...prev, ...metaUpdates }))
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
