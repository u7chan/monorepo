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
  sender: 'user' | 'bot'
  content: string
}

export const Chat: FC = () => {
  const formRef = useRef<HTMLFormElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)

  const [messages, setMessages] = useState<Message[]>([])
  const [streamText, setStreamText] = useState('')
  const [input, setInput] = useState('')
  const [temperature, setTemperature] = useState<number>(1)
  const [textAreaRows, setTextAreaRows] = useState(1)
  const [composing, setComposition] = useState(false)

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [streamText, messages])

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

    const userMessage: Message = { sender: 'user', content: form.userInput }
    setMessages([...messages, userMessage])
    setInput('')

    // Call the Chat API
    const res = await client.api.chat.$post({
      json: {
        llm: form.llm,
        temperature: form.temperature,
        maxTokens: form.maxTokens,
        userInput: form.userInput,
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
    setMessages((prevMessages) => [...prevMessages, { sender: 'bot', content: result }])
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
    <>
      <h2 className='mb-4 font-semibold text-xl'>Chat</h2>
      <div className='chat-container'>
        <div className='message-list h-96 overflow-y-auto border p-2'>
          {messages.map((msg) => (
            <div
              key={`chat_${msg.content}`}
              className={`message mb-2 ${msg.sender === 'user' ? 'text-right' : 'text-left'}`}
            >
              <p
                className={`inline-block whitespace-pre-wrap rounded p-2 ${msg.sender === 'user' ? 'bg-blue-200' : 'bg-gray-200'}`}
              >
                {msg.content}
              </p>
            </div>
          ))}
          {streamText && (
            <div className='message text-left'>
              <p className='inline-block whitespace-pre-wrap rounded bg-gray-200 p-2'>
                {streamText}
              </p>
            </div>
          )}
          <div ref={messageEndRef} />
        </div>
        <form ref={formRef} onSubmit={handleSubmit} className='mt-4 flex flex-col gap-2'>
          <select
            name='llm'
            required
            className='block w-full rounded border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-blue-600'
          >
            <option value='openai'>OpenAI</option>
            <option value='deepseek'>DeepSeek-V3</option>
          </select>
          <div className='flex items-center gap-2'>
            <div className='font-semibold text-md'>temperature</div>
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
            <div className='text-md'>{temperature.toFixed(2)}</div>
          </div>
          <input
            name='maxTokens'
            type='number'
            min={1}
            max={4096}
            placeholder='max tokens'
            className='w-full rounded border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-blue-600'
          />
          <div className='flex items-center gap-2'>
            <textarea
              name='userInput'
              value={input}
              onChange={handleChangeInput}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setComposition(true)}
              onCompositionEnd={() => setComposition(false)}
              rows={textAreaRows}
              placeholder='Type your message here...'
              disabled={!!streamText}
              className='max-h-34 w-full resize-none overflow-y-auto rounded border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-blue-600'
            />
            <button
              type='submit'
              disabled={!!streamText || input.trim().length <= 0}
              className='rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:cursor-not-allowed disabled:bg-gray-400'
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
