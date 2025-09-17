import { useRef, useState } from 'react'
import { generate, generateStream } from './actions'
import { readStreamableValue } from '@ai-sdk/rsc'

export function useChat({ model, stream }: { model: string; stream?: boolean }) {
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

    if (stream) {
      const { output } = await generateStream(model, input)
      for await (const delta of readStreamableValue(output)) {
        setOutputText((prev) => `${prev}${delta}`)
        scrollToBottom()
      }
      setOutputText((prev) => `${prev}\n`)
    } else {
      const { output } = await generate(model, input)
      setOutputText((prev) => `${prev}${output}`)
      scrollToBottom()
    }

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
