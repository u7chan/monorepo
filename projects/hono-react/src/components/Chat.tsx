import {
  useEffect,
  useRef,
  useState,
  type FC,
  type FormEvent,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { hc } from 'hono/client'

import type { AppType } from '../server'

const client = hc<AppType>('/')

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export const Chat: FC = () => {
  const formRef = useRef<HTMLFormElement>(null)
  const messageRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)

  const [messages, setMessages] = useState<Message[]>([])
  const [streamText, setStreamText] = useState('')
  const [input, setInput] = useState('')
  const [temperature, setTemperature] = useState<number>(1)
  const [textAreaRows, setTextAreaRows] = useState(1)
  const [composing, setComposition] = useState(false)
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true)

  useEffect(() => {
    if (!isAtBottom) return
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [streamText, messages, isAtBottom])

  useEffect(() => {
    messageRef?.current?.addEventListener('scroll', handleScroll)
    return () => {
      messageRef?.current?.removeEventListener('scroll', handleScroll)
    }
  }, [])

  const handleScroll = () => {
    if (!messageRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = messageRef.current
    const isAtBottom = Math.floor(scrollHeight - scrollTop) === clientHeight
    setIsAtBottom(isAtBottom)
  }

  const handleChangeTemperature = (event: ChangeEvent<HTMLInputElement>) => {
    setTemperature(Number.parseFloat(event.target.value))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const form = {
      llm: formData.get('llm')?.toString() as 'openai' | 'deepseek',
      temperature: Number(formData.get('temperature')),
      maxTokens: formData.get('maxTokens') ? Number(formData.get('maxTokens')) : null,
      userInput: formData.get('userInput')?.toString() || '',
    }

    const userMessage: Message = { role: 'user', content: form.userInput }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')

    // Call the Chat API
    const res = await client.api.chat.$post({
      json: {
        llm: form.llm,
        temperature: form.temperature,
        maxTokens: form.maxTokens,
        messages: newMessages,
      },
    })
    let result = ''
    if (!res.ok) {
      const { error } = (await res.json()) as { error: unknown }
      result = typeof error === 'string' ? error : JSON.stringify(error)
    } else {
      const reader = res.body?.getReader()
      while (true) {
        const { done, value } = (await reader?.read()) || {}
        if (done) break
        const chunk = new TextDecoder().decode(value)
        // Append chunk to result
        result += chunk
        setStreamText(`${result}...`)
      }
    }
    setMessages((prevMessages) => [...prevMessages, { role: 'assistant', content: result }])
    setStreamText('')
  }

  const handleChangeInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    const lineCount = (value.match(/\n/g) || []).length + 1

    if (lineCount <= 5) {
      setTextAreaRows(lineCount)
    }

    setInput(value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      if (formRef.current) {
        formRef.current.requestSubmit()
      }
    }
  }

  return (
    <div className='flex h-screen items-center justify-center bg-gray-200'>
      <div className='rounded-lg bg-white p-6 text-center shadow-lg'>
        <div className='font-bold text-gray-700 text-xl'>これは中央に寄せられたラベルです</div>
      </div>
    </div>
  )
}
