import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  type FC,
  type FormEvent,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { hc } from 'hono/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { AppType } from '../server'
import { GearIcon } from './svg/GearIcon'
import { ChatbotIcon } from './svg/ChatbotIcon'

const client = hc<AppType>('/')

function readFromLocalStorage(): {
  llm?: string
  temperature?: string
  maxTokens?: string
} {
  const key = 'hono-react.chat-settings'
  return JSON.parse(localStorage.getItem(key) || '{}')
}

function saveToLocalStorage(settings: {
  llm?: string
  temperature?: string
  maxTokens?: string
}) {
  const key = 'hono-react.chat-settings'
  const newSettings = { ...readFromLocalStorage(), ...settings }
  localStorage.setItem(key, JSON.stringify(newSettings))
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export const Chat: FC = () => {
  const formRef = useRef<HTMLFormElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)

  const defaultSettings = useMemo(() => {
    return readFromLocalStorage()
  }, [])

  const [messages, setMessages] = useState<Message[]>([])
  const [streamText, setStreamText] = useState('')
  const [input, setInput] = useState('')
  const [temperature, setTemperature] = useState<number>(
    defaultSettings.temperature ? Number(defaultSettings.temperature) : 1,
  )
  const [textAreaRows, setTextAreaRows] = useState(1)
  const [composing, setComposition] = useState(false)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [showMenu, setShowMenu] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isAtBottom) return
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [streamText, messages, isAtBottom])

  useEffect(() => {
    scrollContainerRef?.current?.addEventListener('scroll', handleScrollContainer)
    scrollContainerRef?.current?.addEventListener('click', handleClickScrollContainer)
    return () => {
      scrollContainerRef?.current?.removeEventListener('scroll', handleScrollContainer)
      scrollContainerRef?.current?.removeEventListener('click', handleClickScrollContainer)
    }
  }, [])

  const handleScrollContainer = () => {
    if (!scrollContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    const isAtBottom = Math.floor(scrollHeight - scrollTop) === clientHeight
    setIsAtBottom(isAtBottom)
  }

  const handleClickScrollContainer = () => {
    setShowMenu(false)
  }

  const handleChangeLLM = (event: ChangeEvent<HTMLSelectElement>) => {
    saveToLocalStorage({ llm: event.target.value })
  }

  const handleChangeTemperature = (event: ChangeEvent<HTMLInputElement>) => {
    setTemperature(Number.parseFloat(event.target.value))
    saveToLocalStorage({ temperature: event.target.value })
  }

  const handleChangeMaxTokens = (event: ChangeEvent<HTMLInputElement>) => {
    saveToLocalStorage({ maxTokens: event.target.value })
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setShowMenu(false)
    setLoading(true)
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
        setStreamText(`${result}●`)
      }
    }
    setMessages((prevMessages) => [...prevMessages, { role: 'assistant', content: result }])
    setStreamText('')
    setLoading(false)
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
      <div className={'absolute'}>
        <button
          type='button'
          onClick={() => setShowMenu(!showMenu)}
          className='relative top-4 left-4 flex cursor-pointer items-center justify-center rounded-full bg-white focus:outline-none focus:ring-2 focus:ring-blue-600'
        >
          <GearIcon color='#5D5D5D' />
        </button>
        <div
          className={`relative top-5 left-10 z-10 grid gap-2 rounded bg-white p-2 shadow ${!showMenu && 'hidden'}`}
        >
          <select
            name='llm'
            required
            defaultValue={defaultSettings.llm}
            onChange={handleChangeLLM}
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
            defaultValue={defaultSettings.maxTokens}
            placeholder='max tokens'
            onChange={handleChangeMaxTokens}
            className='w-full rounded-sm border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600'
          />
        </div>
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
              {messages.map(({ role, content }) => (
                <React.Fragment key={`chat_${content}`}>
                  {role === 'user' && (
                    <div className={'message mb-2 text-right'}>
                      <p
                        className={
                          'inline-block whitespace-pre-wrap rounded-3xl bg-gray-100 px-4 py-2 text-left'
                        }
                      >
                        {content}
                      </p>
                    </div>
                  )}
                  {role === 'assistant' && (
                    <div className='flex'>
                      <div className='flex h-[32px] justify-center rounded-full border-1 border-gray-300 align-center '>
                        <ChatbotIcon size={32} color='#5D5D5D' />
                      </div>
                      <div className='message text-left'>
                        <Markdown remarkPlugins={[remarkGfm]} className='prose mt-1 ml-2'>
                          {content}
                        </Markdown>
                      </div>
                    </div>
                  )}
                </React.Fragment>
              ))}
              {streamText && (
                <div className='flex align-item'>
                  <div className='flex h-[32px] justify-center rounded-full border-1 border-gray-300 align-center '>
                    <ChatbotIcon size={32} color='#5D5D5D' />
                  </div>
                  <div className='message text-left'>
                    <p className='mt-1 ml-2 inline-block whitespace-pre-wrap '>{streamText}</p>
                  </div>
                </div>
              )}
              <div ref={messageEndRef} />
            </div>
          </div>
          <div className={`flex items-center gap-2 ${loading && 'opacity-40'}`}>
            <textarea
              name='userInput'
              value={input}
              onChange={handleChangeInput}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setComposition(true)}
              onCompositionEnd={() => setComposition(false)}
              rows={textAreaRows}
              placeholder={loading ? 'しばらくお待ちください' : 'メッセージを送信する'}
              disabled={loading}
              className='max-h-34 w-full resize-none overflow-y-auto rounded-2xl border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600'
            />
            <button
              type='submit'
              disabled={loading || !!streamText || input.trim().length <= 0}
              className='whitespace-nowrap rounded-4xl bg-blue-400 px-4 py-2 text-white hover:bg-blue-300 focus:outline-hidden focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:bg-gray-400'
            >
              送信
            </button>
          </div>
        </div>
      </div>
    </form>
  )
}
