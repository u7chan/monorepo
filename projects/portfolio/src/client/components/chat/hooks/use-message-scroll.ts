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
  const scrollAnimationFrameRef = useRef<number | null>(null)
  const [bottomChatInputContainerHeight, setBottomChatInputContainerHeight] = useState(0)
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationFrameRef.current === null) return
    cancelAnimationFrame(scrollAnimationFrameRef.current)
    scrollAnimationFrameRef.current = null
  }, [])

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

  useEffect(() => cancelScrollAnimation, [cancelScrollAnimation])

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

  const scrollToMessageEnd = useCallback(
    (behavior: ScrollBehavior = 'instant') => {
      setIsPinnedToBottom(true)
      const scrollContainer = scrollContainerRef.current
      if (behavior === 'smooth' && scrollContainer) {
        cancelScrollAnimation()

        const targetScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
        const startScrollTop = scrollContainer.scrollTop
        const distance = targetScrollTop - startScrollTop
        const prefersReducedMotion =
          typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

        if (prefersReducedMotion || Math.abs(distance) < 4) {
          scrollContainer.scrollTop = targetScrollTop
          return
        }

        const duration = Math.min(520, Math.max(280, Math.abs(distance) * 0.35))
        const startTime = performance.now()
        const easeOutQuart = (progress: number) => 1 - (1 - progress) ** 4
        const animate = (currentTime: number) => {
          const elapsed = currentTime - startTime
          const progress = Math.min(elapsed / duration, 1)
          scrollContainer.scrollTop = startScrollTop + distance * easeOutQuart(progress)

          if (progress < 1) {
            scrollAnimationFrameRef.current = requestAnimationFrame(animate)
          } else {
            scrollAnimationFrameRef.current = null
          }
        }

        scrollAnimationFrameRef.current = requestAnimationFrame(animate)
        return
      }

      messageEndRef.current?.scrollIntoView({
        behavior,
        block: 'end',
      })
    },
    [cancelScrollAnimation]
  )

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
