import { useEffect, useRef, useState } from 'react'
import { readStreamableValue } from '@ai-sdk/rsc'

import { AgentMessage, agentStream, TokenUsage } from '@/features/agent/actions'
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

  const handleSubmit = async (input: string) => {
    autoScrollEnabled.current = true
    const newMessages: AgentMessage[] = [...messages, { role: 'user', content: input }]
    setMessages(newMessages)
    setStreamMessage('')
    setLoading(true)

    let streamMessage = ''

    setProcessingTimeMs(undefined)
    const { output } = await agentStream(newMessages, agentConfig)
    for await (const stream of readStreamableValue(output)) {
      const { delta, tools, usage, finishReason, processingTimeMs: streamProcessingTimeMs } = stream || {
        delta: '',
        tools: [],
        usage: undefined,
        finishReason: undefined,
        processingTimeMs: undefined,
      }
      if (delta) {
        streamMessage += delta
        setStreamMessage(streamMessage)
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
    setMessages((prev) => [...prev, { role: 'assistant', content: streamMessage }])

    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
    updateScrollState()
    setLoading(false)
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
  }
}
