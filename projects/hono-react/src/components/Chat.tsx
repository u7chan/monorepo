import { useEffect, useRef, useState, type FC, type ChangeEvent, type KeyboardEvent } from 'react'
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
  const [selectedOption, setSelectedOption] = useState<'openai' | 'deepseek'>('openai')
  const [textAreaRows, setTextAreaRows] = useState(1)

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [streamText, messages])

  const handleChangeLLM = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedOption(event.target.value as never)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!input.trim()) return

    const userMessage: Message = { sender: 'user', content: input }
    setMessages([...messages, userMessage])
    setInput('')

    // Call the Chat API
    const res = await client.api.chat.$post({
      form: {
        llm: selectedOption,
        message: input,
      },
    })
    let result = ''
    if (!res.ok) {
      const { error } = (await res.json()) as { error: string }
      result = error
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
    console.log('#lineCount', lineCount)

    setInput(value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (formRef.current) {
        formRef.current.dispatchEvent(new Event('submit', { bubbles: true }))
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
            value={selectedOption}
            onChange={handleChangeLLM}
            className='block w-full rounded border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-blue-600'
          >
            <option value='openai'>OpenAI</option>
            <option value='deepseek'>DeepSeek-V3</option>
          </select>
          <div className='flex items-center gap-2'>
            <textarea
              value={input}
              onChange={handleChangeInput}
              onKeyDown={handleKeyDown}
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
