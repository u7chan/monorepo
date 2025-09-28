import { useRef, useState } from 'react'
import { readStreamableValue } from '@ai-sdk/rsc'

import { agentStream } from '@/features/agent/actions'
import { AgentConfig } from '@/features/agent/types'

export function useChat({ agentConfig }: { agentConfig: AgentConfig }) {
  const [loading, setLoading] = useState(false)
  const [inputText, setInputText] = useState('')
  const [outputText, setOutputText] = useState('')
  const scrollContainer = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    setTimeout(() => {
      scrollContainer.current?.scrollIntoView({ behavior: 'smooth' })
    }, 1)
  }

  const handleSubmit = async (input: string) => {
    setInputText(input)
    setOutputText('')
    setLoading(true)

    const { output } = await agentStream(input, agentConfig)
    for await (const payload of readStreamableValue(output)) {
      if (payload?.delta) {
        setOutputText((prev) => `${prev}${payload.delta}`)
        scrollToBottom()
      }
    }

    setOutputText((prev) => `${prev}\n`)
    setLoading(false)
  }

  return {
    loading,
    inputText,
    outputText,
    scrollContainer,
    handleSubmit,
  }
}
