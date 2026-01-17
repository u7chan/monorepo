import { useRef, useState } from 'react'
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

  const scrollToBottom = () => {
    setTimeout(() => {
      scrollContainer.current?.scrollIntoView({ behavior: 'smooth' })
    }, 1)
  }

  const handleSubmit = async (input: string) => {
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
        scrollToBottom()
      }
      setStreamMessage((prev) => `${prev}\n`)
    } else {
      const { output } = await generate(model, input)
      setStreamMessage((prev) => `${prev}${output}`)
      scrollToBottom()
    }

    setLoading(false)
  }

  return {
    loading,
    messages,
    streamMessage,
    scrollContainer,
    handleSubmit,
  }
}
