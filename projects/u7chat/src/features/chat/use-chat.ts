import { useState } from 'react'
import { generate } from './chat-actions'
import { readStreamableValue } from '@ai-sdk/rsc'

export function useChat(model: string) {
  const [loading, setLoading] = useState(false)
  const [inputText, setInputText] = useState('')
  const [streamText, setStreamText] = useState('')

  const handleSubmit = async (input: string) => {
    setInputText(input)
    setStreamText('')
    setLoading(true)

    const { output } = await generate(model, input)

    for await (const delta of readStreamableValue(output)) {
      setStreamText((prev) => `${prev}${delta}`)
    }
    setStreamText((prev) => `${prev}\n`)
    setLoading(false)
  }

  return {
    loading,
    inputText,
    streamText,
    handleSubmit,
  }
}
