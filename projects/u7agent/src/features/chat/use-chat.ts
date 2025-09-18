import { useRef, useState } from 'react'
import { generateStream } from './actions'
import { readStreamableValue } from '@ai-sdk/rsc'

export function useChat({ model }: { model: string }) {
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

    const { output } = await generateStream(model, input)
    for await (const delta of readStreamableValue(output)) {
      setOutputText((prev) => `${prev}${delta}`)
      scrollToBottom()
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
