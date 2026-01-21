import type { ToolApprovalResponse } from 'ai'
import { useEffect, useRef, useState } from 'react'
import { readStreamableValue } from '@ai-sdk/rsc'

import { AgentMessage, agentStream, AssistantMessage, TextPart, TokenUsage } from '@/features/agent/actions'
import { AgentConfig } from '@/features/agent/types'

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

  const filterMessagesForAgent = (messages: AgentMessage[]) => {
    return messages.reduce<AgentMessage[]>((acc, message) => {
      if (message.role === 'assistant') {
        const assistantTextContent = message.content.filter(
          (content): content is TextPart => content.type === 'text',
        )
        if (assistantTextContent.length > 0) {
          acc.push({ role: 'assistant', content: assistantTextContent } as AssistantMessage)
        }
        return acc
      }
      if (message.role === 'tool-approval-request') {
        return acc
      }
      acc.push(message)
      return acc
    }, [])
  }

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
