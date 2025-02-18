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
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'

import type { AppType } from '../server'
import { GearIcon } from './svg/GearIcon'
import { ChatbotIcon } from './svg/ChatbotIcon'
import { SpinnerIcon } from './svg/SpinnerIcon'
import { ChatInput } from './ChatInput'
import { useResponsive } from './ResponsiveProvider'

const client = hc<AppType>('/')

function readFromLocalStorage(): {
  model?: string
  temperature?: string
  maxTokens?: string
  markdownPreview?: boolean
} {
  const key = 'hono-react.chat-settings'
  return JSON.parse(localStorage.getItem(key) || '{}')
}

function saveToLocalStorage(settings: {
  model?: string
  temperature?: string
  maxTokens?: string
  markdownPreview?: boolean
}) {
  const key = 'hono-react.chat-settings'
  const newSettings = { ...readFromLocalStorage(), ...settings }
  localStorage.setItem(key, JSON.stringify(newSettings))
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
function CodeBlock(props: any) {
  const { className = '', children = '' } = props as {
    className?: string
    children?: string
  }
  const language = className?.split('-')[1]
  if (!language) return <code>{children}</code>
  return <SyntaxHighlighter language={language}>{children}</SyntaxHighlighter>
}

const supportedModels = [
  {
    value: 'OpenAI (gpt-4o-mini)',
    llm: 'openai',
    model: 'gpt-4o-mini',
  },
  {
    value: 'OpenAI (gpt-4o)',
    llm: 'openai',
    model: 'gpt-4o',
  },
  {
    value: 'DeepSeek (DeepSeek-V3)',
    llm: 'deepseek',
    model: 'deepseek-chat',
  },
  {
    value: 'Test Stream',
    llm: 'test',
    model: 'dummy',
  },
] as const

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export const Chat: FC = () => {
  const formRef = useRef<HTMLFormElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const buttomContainerRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const { mobile } = useResponsive()

  const defaultSettings = useMemo(() => {
    return readFromLocalStorage()
  }, [])

  const [messages, setMessages] = useState<Message[]>([])
  const [stream, setStream] = useState('')
  const [streamResult, setStreamResult] = useState<{
    finishReason: string
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    } | null
  } | null>(null)
  const [input, setInput] = useState('')
  const [temperature, setTemperature] = useState<number>(
    defaultSettings.temperature ? Number(defaultSettings.temperature) : 0.7,
  )
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(!!defaultSettings.markdownPreview)
  const [textAreaRows, setTextAreaRows] = useState(1)
  const [composing, setComposition] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [loading, setLoading] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    scrollContainerRef?.current?.addEventListener('click', handleClickScrollContainer)
    buttomContainerRef?.current?.addEventListener('click', handleClickScrollContainer)
    return () => {
      scrollContainerRef?.current?.removeEventListener('click', handleClickScrollContainer)
      buttomContainerRef?.current?.removeEventListener('click', handleClickScrollContainer)
    }
  }, [])

  useEffect(() => {
    if (!loading) return
    messageEndRef?.current?.scrollIntoView()
  }, [loading])

  useEffect(() => {
    if (!autoScroll) return
    messageEndRef?.current?.scrollIntoView()
  }, [stream, autoScroll])

  const handleScroll = () => {
    if (!scrollContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current

    if (scrollTop + clientHeight >= scrollHeight - 36) {
      setAutoScroll(true)
    } else {
      setAutoScroll(false)
    }
  }

  const handleClickScrollContainer = () => {
    setShowMenu(false)
  }

  const handleChangeModel = (event: ChangeEvent<HTMLSelectElement>) => {
    saveToLocalStorage({ model: event.target.value })
  }

  const handleChangeTemperature = (event: ChangeEvent<HTMLInputElement>) => {
    setTemperature(Number.parseFloat(event.target.value))
    saveToLocalStorage({ temperature: event.target.value })
  }

  const handleChangeMaxTokens = (event: ChangeEvent<HTMLInputElement>) => {
    saveToLocalStorage({ maxTokens: event.target.value })
  }

  const handleClickShowMarkdownPreview = () => {
    const markdownPreview = !showMarkdownPreview
    setShowMarkdownPreview(markdownPreview)
    saveToLocalStorage({ markdownPreview })
  }

  const handleStreamCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const value = formData.get('model')?.toString() || ''
    const form = {
      llm: supportedModels.find((x) => x.value === value)?.llm || 'test',
      model: supportedModels.find((x) => x.value === value)?.model || '',
      temperature: Number(formData.get('temperature')),
      maxTokens: formData.get('maxTokens') ? Number(formData.get('maxTokens')) : null,
      userInput: formData.get('userInput')?.toString() || '',
    }
    if (!form.userInput.trim()) {
      return
    }

    setShowMenu(false)
    setLoading(true)

    const userMessage: Message = { role: 'user', content: form.userInput }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')

    let result = ''
    let finishReason = ''
    let usage: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    } | null = null

    // Call the Chat API
    abortControllerRef.current = new AbortController()
    try {
      const res = await client.api.chat.$post(
        {
          json: {
            llm: form.llm,
            model: form.model,
            temperature: form.temperature,
            maxTokens: form.maxTokens,
            messages: newMessages,
          },
        },
        { init: { signal: abortControllerRef.current.signal } },
      )

      if (!res.ok) {
        const { error } = (await res.json()) as { error: unknown }
        result = typeof error === 'string' ? error : JSON.stringify(error)
      } else {
        const reader = res.body?.getReader()
        while (true) {
          const { done, value } = (await reader?.read()) || {}
          if (done) break
          const chunk = new TextDecoder().decode(value)
          const data = chunk
            .split('\n')
            .map((x) => x.split('data: ')[1])
            .filter((x) => x)
            .map(
              (x) =>
                JSON.parse(x) as {
                  content: string
                  finish_reason?: string
                  usage?: {
                    prompt_tokens: number
                    completion_tokens: number
                    total_tokens: number
                  }
                },
            )
          // Append chunk to result
          result += data.map((x) => x.content).join('')
          finishReason = data.find((x) => x.finish_reason)?.finish_reason || ''
          usage = data.find((x) => x.usage)?.usage ?? null
          setStream(`${result}●`)
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        // Stream canceled
      } else {
        throw e
      }
    }
    if (result) {
      setMessages((prevMessages) => [...prevMessages, { role: 'assistant', content: result }])
      setStreamResult({
        finishReason,
        usage: usage && {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        },
      })
    }
    setStream('')
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

  const handleChangeComposition = (composition: boolean) => {
    setComposition(composition)
  }

  const emptyMessage = messages.length === 0

  return (
    <form ref={formRef} onSubmit={handleSubmit} className=''>
      <div className={`absolute ${mobile ? ' top-14' : 'top-4'}`}>
        <button
          type='button'
          onClick={() => setShowMenu(!showMenu)}
          className='relative top-4 left-4 flex cursor-pointer items-center justify-center rounded-full bg-white focus:outline-none focus:ring-2 focus:ring-blue-600'
        >
          <GearIcon color='#5D5D5D' />
        </button>
      </div>

      <div
        className={`fixed top-14 left-40 z-10 grid gap-2 rounded border bg-white p-2 shadow-xl ${!showMenu && 'hidden'}`}
      >
        <select
          name='model'
          required
          defaultValue={defaultSettings.model}
          onChange={handleChangeModel}
          className='block w-full rounded-sm border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600'
        >
          {supportedModels.map(({ value }) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <div className='flex items-center gap-2'>
          <span className='ml-1 text-md'>temperature</span>
          <input
            name='temperature'
            type='range'
            min='0'
            max='1'
            step='0.01'
            value={temperature}
            onChange={handleChangeTemperature}
            disabled={!!stream}
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
        <div className='flex items-center gap-2'>
          <span className='ml-1 text-md'>markdown preview</span>
          <button
            type='button'
            className={`flex h-8 w-14 cursor-pointer items-center rounded-full p-1 transition-colors duration-300 ${
              showMarkdownPreview ? 'bg-blue-500' : 'bg-gray-400'
            }`}
            onClick={handleClickShowMarkdownPreview}
          >
            <div
              className={`h-6 w-6 transform rounded-full bg-white shadow-md transition-transform duration-300 ${
                showMarkdownPreview ? 'translate-x-6' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={`max-h flex h-screen overflow-y-auto ${!emptyMessage && 'max-h-[calc(100vh-162px)]'}`}
      >
        {emptyMessage && (
          <div className='flex flex-1 items-center justify-center'>
            <div className='grid flex-1 gap-2'>
              <div className='text-center font-bold text-2xl text-gray-700'>
                お手伝いできることはありますか？
              </div>
              <ChatInput
                name='userInput'
                value={input}
                textAreaRows={textAreaRows}
                loading={loading}
                disabled={loading || !!stream || input.trim().length <= 0}
                handleChangeInput={handleChangeInput}
                handleKeyDown={handleKeyDown}
                handleChangeComposition={handleChangeComposition}
                handleClickStop={handleStreamCancel}
              />
            </div>
          </div>
        )}
        {!emptyMessage && (
          <div className='container mx-auto mt-4 max-w-screen-lg px-4'>
            <div className='message-list'>
              {messages.map(({ role, content }, index) => (
                <React.Fragment key={`chat_${index}`}>
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
                        {showMarkdownPreview ? (
                          <Markdown
                            remarkPlugins={[remarkGfm]}
                            components={{ code: CodeBlock }}
                            className='prose mt-1 ml-2'
                          >
                            {content}
                          </Markdown>
                        ) : (
                          <div className='message text-left'>
                            <p className='mt-1 ml-2 inline-block whitespace-pre-wrap'>{content}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </React.Fragment>
              ))}
              {loading && (
                <div className='flex align-item'>
                  <div className='flex h-[32px] justify-center rounded-full border-1 border-gray-300 align-center '>
                    <ChatbotIcon size={32} color='#5D5D5D' />
                  </div>
                  {stream ? (
                    <div className='message text-left'>
                      {showMarkdownPreview ? (
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={{ code: CodeBlock }}
                          className='prose mt-1 ml-2'
                        >
                          {stream}
                        </Markdown>
                      ) : (
                        <div className='message text-left'>
                          <p className='mt-1 ml-2 inline-block whitespace-pre-wrap'>{stream}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className='ml-2 scale-75'>
                      <SpinnerIcon />
                    </div>
                  )}
                </div>
              )}

              {!loading && streamResult?.usage && (
                <div className='mt-2 flex justify-end'>
                  <div className='flex items-center gap-2 rounded bg-gray-100 px-2 py-1 text-xs'>
                    <div>
                      <span className='mr-1'>Input:</span>
                      <span>{streamResult.usage?.promptTokens}</span>
                    </div>
                    <div>
                      <span className='mr-1'>Output:</span>
                      <span>{streamResult.usage?.completionTokens}</span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messageEndRef} />
            </div>
          </div>
        )}
      </div>
      <div ref={buttomContainerRef}>
        {!emptyMessage && (
          <ChatInput
            name='userInput'
            value={input}
            textAreaRows={textAreaRows}
            loading={loading}
            disabled={loading || !!stream || input.trim().length <= 0}
            handleChangeInput={handleChangeInput}
            handleKeyDown={handleKeyDown}
            handleChangeComposition={handleChangeComposition}
            handleClickStop={handleStreamCancel}
          />
        )}
      </div>
    </form>
  )
}
