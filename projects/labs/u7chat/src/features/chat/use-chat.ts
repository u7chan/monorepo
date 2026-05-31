import { useEffect, useRef, useState } from 'react'
import { generate, generateStream } from './actions'
import { readStreamableValue } from '@ai-sdk/rsc'

export function useChat({ model, stream }: { model: string; stream?: boolean }) {
  const [loading, setLoading] = useState(false)
  const [streamMessage, setStreamMessage] = useState('')
  const [messages, setMessages] = useState<
    {
      role: 'user' | 'assistant' | 'system'
      content: string
    }[]
  >([])
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
    const newMessages: {
      role: 'user' | 'assistant' | 'system'
      content: string
    }[] =
      streamMessage !== ''
        ? [...messages, { role: 'assistant', content: streamMessage }, { role: 'user', content: input }]
        : [...messages, { role: 'user', content: input }]
    setMessages(newMessages)
    setStreamMessage('')
    setLoading(true)

    if (stream) {
      const { output } = await generateStream(model, newMessages)
      for await (const delta of readStreamableValue(output)) {
        setStreamMessage((prev) => `${prev}${delta}`)
        if (autoScrollEnabled.current) {
          requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
        }
      }
      setStreamMessage((prev) => `${prev}\n`)
    } else {
      const { output } = await generate(model, input)
      setStreamMessage((prev) => `${prev}${output}`)
      scrollToBottom()
    }

    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
    updateScrollState()
    setLoading(false)
  }

  return {
    loading,
    messages,
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
