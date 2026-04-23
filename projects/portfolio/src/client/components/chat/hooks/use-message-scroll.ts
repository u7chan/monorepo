import type { ChatStreamState } from '#/client/components/chat/hooks/chat-response'
import type { Message } from '#/types'
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseMessageScrollParams {
  loading: boolean
  streamMode: boolean
  stream: ChatStreamState | null
  messages: Message[]
}

export function useMessageScroll({ loading, streamMode, stream, messages }: UseMessageScrollParams) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomChatInputContainerRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const [bottomChatInputContainerHeight, setBottomChatInputContainerHeight] = useState(0)
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)

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
    if (!isPinnedToBottom) return
    messageEndRef.current?.scrollIntoView(!streamMode && { behavior: 'smooth' })
  }, [stream, messages.length, streamMode, isPinnedToBottom, bottomChatInputContainerHeight])

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    const threshold = 36
    if (scrollTop + clientHeight >= scrollHeight - threshold) {
      setIsPinnedToBottom(true)
    } else {
      setIsPinnedToBottom(false)
    }
  }, [])

  const scrollToMessageEnd = useCallback((behavior: ScrollBehavior = 'instant') => {
    setIsPinnedToBottom(true)
    messageEndRef.current?.scrollIntoView({
      behavior,
      block: 'end',
    })
  }, [])

  return {
    scrollContainerRef,
    bottomChatInputContainerRef,
    bottomChatInputContainerHeight,
    messageEndRef,
    isPinnedToBottom,
    handleScroll,
    scrollToMessageEnd,
  }
}
