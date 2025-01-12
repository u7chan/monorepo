import { useEffect, useRef, useState, type FC } from 'react'
import { hc } from 'hono/client'

import type { AppType } from '../server'

const client = hc<AppType>('/')

interface Message {
  sender: 'user' | 'bot'
  content: string
}

export const Chat: FC = () => {
  const [messages, setMessages] = useState<Message[]>([])
  const [streamText, setStreamText] = useState('')
  const [input, setInput] = useState('')

  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [streamText])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!input.trim()) return

    const userMessage: Message = { sender: 'user', content: input }
    setMessages([...messages, userMessage])
    setInput('')

    // Call the Chat API
    const res = await client.api.chat.$post({
      form: {
        message: input,
      },
    })
    const reader = res.body?.getReader()
    let result = ''
    while (true) {
      const { done, value } = (await reader?.read()) || {}
      if (done) break
      const chunk = new TextDecoder().decode(value).trimEnd()
      // Append chunk to result
      result += chunk
      setStreamText(`${result}...`)
    }
    setMessages((prevMessages) => [...prevMessages, { sender: 'bot', content: result }])
    setStreamText('')
  }

  return (
    <>
      <h2 className='mb-4 font-semibold text-xl'>Chat</h2>
      <div className='chat-container'>
        <div className='message-list h-96 overflow-y-auto border p-2'>
          {messages.map((msg) => (
            <div
              key={`chat_${msg}`}
              className={`message mb-2 ${msg.sender === 'user' ? 'text-right' : 'text-left'}`}
            >
              <p
                className={`inline-block rounded p-2 ${msg.sender === 'user' ? 'bg-blue-200' : 'bg-gray-200'}`}
              >
                {msg.content}
              </p>
            </div>
          ))}
          {streamText && (
            <div className='message text-left'>
              <p className='inline-block rounded bg-gray-200 p-2'>{streamText}</p>
            </div>
          )}
          <div ref={messageEndRef} />
        </div>
        <form onSubmit={handleSubmit} className='mt-4'>
          <input
            type='text'
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Type your message here...'
            disabled={!!streamText}
            className='w-full border p-2'
          />
          <button
            type='submit'
            disabled={!!streamText}
            className='mt-2 w-full rounded bg-blue-500 p-2 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-400'
          >
            Send
          </button>
        </form>
      </div>
    </>
  )
}
