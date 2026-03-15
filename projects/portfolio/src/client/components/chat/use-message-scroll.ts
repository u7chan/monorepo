import { useEffect, useRef, useState } from 'react'

interface UseMessageScrollParams {
  loading: boolean
  streamMode: boolean
  stream: {
    content: string
    reasoning_content?: string
  } | null
  chatResults: {
    model?: string
    finish_reason: string
    responseTimeMs?: number
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    } | null
  } | null
}

export function useMessageScroll({ loading, streamMode, stream, chatResults }: UseMessageScrollParams) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomChatInputContainerRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const [bottomChatInputContainerHeight, setBottomChatInputContainerHeight] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    const bottomChatInputContainerObserver = new ResizeObserver(([element]) => {
      setBottomChatInputContainerHeight(element.contentRect.height)
    })

    if (bottomChatInputContainerRef.current) {
      bottomChatInputContainerObserver.observe(bottomChatInputContainerRef.current)
    }

    return () => {
      if (bottomChatInputContainerRef.current) {
        bottomChatInputContainerObserver.unobserve(bottomChatInputContainerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!loading) return
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [loading])

  useEffect(() => {
    if (!autoScroll) return
    messageEndRef.current?.scrollIntoView(!streamMode && { behavior: 'smooth' })
  }, [stream, chatResults, streamMode, autoScroll, bottomChatInputContainerHeight])

  const handleScroll = () => {
    if (!scrollContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    const threshold = 36
    if (scrollTop + clientHeight >= scrollHeight - threshold) {
      setAutoScroll(true)
    } else {
      setAutoScroll(false)
    }
  }

  const scrollToMessageEnd = (behavior: ScrollBehavior = 'instant') => {
    messageEndRef.current?.scrollIntoView({
      behavior,
      block: 'end',
    })
  }

  return {
    scrollContainerRef,
    bottomChatInputContainerRef,
    bottomChatInputContainerHeight,
    messageEndRef,
    handleScroll,
    scrollToMessageEnd,
  }
}
