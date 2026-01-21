import type { TextPart, ToolApprovalResponse } from 'ai'
import { useEffect, useRef, useState } from 'react'
import { readStreamableValue } from '@ai-sdk/rsc'

import { AgentMessage, agentStream, AssistantMessage, TokenUsage } from '@/features/agent/actions'
import { AgentConfig } from '@/features/agent/types'

const TOOL_TYPES_TO_REMOVE = new Set(['tool-call', 'tool-approval-response'])

// TODO: まだ挙動があやしい。連続してApprovalツールを呼び出した時に期待通り動かない。
const filterMessagesForAgent = (messages: AgentMessage[]) => {
  // assistant の text が存在するか確認
  const hasAssistantText = messages.some(
    (m) => m.role === 'assistant' && m.content?.some((c) => c.type === 'text' && c.text?.trim()),
  )

  return (
    messages
      // 既存条件
      .filter((m) => m.role !== 'custom-tool-message' && m.role !== 'custom-tool-approval-request')
      // assistant の content を調整
      .map((m) => {
        if (hasAssistantText && m.role === 'assistant' && Array.isArray(m.content)) {
          return {
            ...m,
            content: m.content.filter((c) => !TOOL_TYPES_TO_REMOVE.has(c.type)),
          }
        }
        return m
      })
  )
}

export function useChat({ agentConfig }: { agentConfig: AgentConfig }) {
  const [loading, setLoading] = useState(false)
  const [streamMessage, setStreamMessage] = useState('')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | undefined>()
  const [finishReason, setFinishReason] = useState<string | undefined>()
  const [processingTimeMs, setProcessingTimeMs] = useState<number | undefined>()
  const scrollContainer = useRef<HTMLDivElement>(null)
  const scrollWrapper = useRef<HTMLDivElement>(null)
  const [isNearBottom, setIsNearBottom] = useState(true)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const autoScrollEnabled = useRef(true)

  const scrollToBottom = (force = false) => {
    if (force) {
      autoScrollEnabled.current = true
      setIsNearBottom(true)
      setShowJumpButton(false)
    }
    if (!autoScrollEnabled.current && !force) return
    const wrapper = scrollWrapper.current
    const runScroll = () => {
      if (!autoScrollEnabled.current && !force) return
      if (wrapper) {
        wrapper.scrollTo({ top: wrapper.scrollHeight, behavior: 'smooth' })
        return
      }
      scrollContainer.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
    requestAnimationFrame(() => requestAnimationFrame(runScroll))
  }

  const updateScrollState = () => {
    const wrapper = scrollWrapper.current
    if (!wrapper) return
    const autoScrollThreshold = 180
    const jumpButtonThreshold = 260
    const distanceFromBottom = wrapper.scrollHeight - wrapper.scrollTop - wrapper.clientHeight
    const nearBottom = distanceFromBottom <= autoScrollThreshold
    setIsNearBottom(nearBottom)
    autoScrollEnabled.current = nearBottom
    setShowJumpButton(distanceFromBottom > jumpButtonThreshold)
  }

  useEffect(() => {
    updateScrollState()
  }, [])

  const runAgentStream = async (newMessages: AgentMessage[]) => {
    setStreamMessage('')
    setLoading(true)
    setProcessingTimeMs(undefined)
    const { output } = await agentStream(filterMessagesForAgent(newMessages), agentConfig)
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
      updateScrollState()
      if (autoScrollEnabled.current) {
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
      }
    }
    setStreamMessage('')
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
    updateScrollState()
    setLoading(false)
  }

  const handleSubmit = async (input: string) => {
    autoScrollEnabled.current = true
    const newMessages: AgentMessage[] = [...messages, { role: 'user', content: input }]
    setMessages(newMessages)
    await runAgentStream(newMessages)
  }

  const handleToolApproval = async (approvalId: string, approved: boolean) => {
    autoScrollEnabled.current = true
    const approvals: ToolApprovalResponse[] = [
      {
        type: 'tool-approval-response',
        approvalId,
        approved,
      },
    ]
    const newMessages: AgentMessage[] = [...messages, { role: 'tool', content: approvals }]
    setMessages(newMessages)
    await runAgentStream(newMessages)
  }

  return {
    loading,
    messages,
    tokenUsage,
    finishReason,
    processingTimeMs,
    streamMessage,
    scrollContainer,
    scrollWrapper,
    isNearBottom,
    showJumpButton,
    scrollToBottom,
    updateScrollState,
    handleSubmit,
    handleToolApproval,
  }
}
