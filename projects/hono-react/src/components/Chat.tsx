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
  const scrollContainerRef = useRef<HTMLDivElement>(null)
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
    scrollContainerRef?.current?.addEventListener('scroll', handleScroll)
    return () => {
      scrollContainerRef?.current?.removeEventListener('scroll', handleScroll)
    }
  }, [])

  const handleScroll = () => {
    if (!scrollContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
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

  const emptyMessage = messages.length === 0

  return (
    <form ref={formRef} onSubmit={handleSubmit}>
      <div
        className={`absolute top-2 z-10 grid gap-2 rounded bg-white p-2 opacity-10 hover:opacity-100 hover:shadow ${!!streamText && 'hidden'}`}
      >
        <select
          name='llm'
          required
          className='block w-full rounded-sm border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600'
        >
          <option value='openai'>OpenAI (gpt-4o-mini)</option>
          <option value='deepseek'>DeepSeek (DeepSeek-V3)</option>
          <option value='test'>Test Stream</option>
        </select>
        <div className='flex items-center gap-2'>
          <div className='ml-1 text-md'>temperature</div>
          <input
            name='temperature'
            type='range'
            min='0'
            max='1'
            step='0.01'
            value={temperature}
            onChange={handleChangeTemperature}
            disabled={!!streamText}
            className='range-slider h-2 w-full cursor-pointer appearance-none rounded-lg bg-blue-300'
          />
          <div className='mr-1 text-md'>{temperature.toFixed(2)}</div>
        </div>
        <input
          name='maxTokens'
          type='number'
          min={1}
          max={4096}
          placeholder='max tokens'
          className='w-full rounded-sm border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600'
        />
      </div>
      <div
        ref={scrollContainerRef}
        className={`flex h-screen justify-center ${emptyMessage ? 'items-center' : 'max-h-[calc(100vh-20px)] overflow-y-auto py-10'}`}
      >
        <div className='container grid gap-2 px-4'>
          {emptyMessage && (
            <div className='flex justify-center'>
              <div className='font-bold text-2xl text-gray-700'>
                お手伝いできることはありますか？
              </div>
            </div>
          )}
          <div className='chat-container'>
            <div className='message-list'>
              {messages.map((msg) => (
                <div
                  key={`chat_${msg.content}`}
                  className={`message mb-2 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}
                >
                  <p
                    className={`inline-block whitespace-pre-wrap text-left ${msg.role === 'user' ? 'rounded-3xl bg-gray-100 px-4 py-2' : ''}`}
                  >
                    {msg.content}
                  </p>
                </div>
              ))}
              {streamText && (
                <div className='message text-left'>
                  <p className='inline-block whitespace-pre-wrap'>{streamText}</p>
                </div>
              )}
              <div ref={messageEndRef} />
            </div>
          </div>
          <div className='flex items-center gap-2'>
            <textarea
              name='userInput'
              value={input}
              onChange={handleChangeInput}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setComposition(true)}
              onCompositionEnd={() => setComposition(false)}
              rows={textAreaRows}
              placeholder={
                streamText ? 'Waiting for this messages...' : 'Type your message here...'
              }
              disabled={!!streamText}
              className='max-h-34 w-full resize-none overflow-y-auto rounded-2xl border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600'
            />
            <button
              type='submit'
              disabled={!!streamText || input.trim().length <= 0}
              className='rounded-4xl bg-blue-400 px-4 py-2 text-white hover:bg-blue-300 focus:outline-hidden focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:bg-gray-400'
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </form>
  )
}
