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
import { NewChatIcon } from './svg/NewChatIcon'
import { ChatInput } from './input/ChatInput'
import { ToggleInput } from './input/ToggleInput'
import { useResponsive } from './hooks/useResponsive'
import { ArrowUpIcon } from './svg/ArrowUpIcon'
import { StopIcon } from './svg/StopIcon'

const client = hc<AppType>('/')

type Settings = {
  model: string
  temperature: string
  maxTokens: string
  markdownPreview: boolean
  interactiveMode: boolean
}

function readFromLocalStorage(): Partial<Settings> {
  const key = 'portfolio.chat-settings'
  return JSON.parse(localStorage.getItem(key) || '{}')
}

function saveToLocalStorage(settings: Partial<Settings>) {
  const key = 'portfolio.chat-settings'
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

const MIN_TEXT_LINE_COUNT = 2
const MAX_TEXT_LINE_COUNT = 5
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
  const [markdownPreview, setMarkdownPreview] = useState(defaultSettings?.markdownPreview ?? true)
  const [interactiveMode, setInteractiveMode] = useState(defaultSettings?.interactiveMode ?? true)
  const [textAreaRows, setTextAreaRows] = useState(MIN_TEXT_LINE_COUNT)
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

  const handleClickNewChat = () => {
    setShowMenu(false)
    setMessages([])
    setInput('')
    setTextAreaRows(MIN_TEXT_LINE_COUNT)
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
    const newMarkdownPreview = !markdownPreview
    setMarkdownPreview(newMarkdownPreview)
    saveToLocalStorage({ markdownPreview: newMarkdownPreview })
  }

  const handleClickInteractiveMode = () => {
    const newInteractiveMode = !interactiveMode
    setInteractiveMode(newInteractiveMode)
    saveToLocalStorage({ interactiveMode: newInteractiveMode })
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
    setTextAreaRows(MIN_TEXT_LINE_COUNT)

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
            messages: interactiveMode ? newMessages : [userMessage],
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

    if (lineCount <= MIN_TEXT_LINE_COUNT) {
      setTextAreaRows(MIN_TEXT_LINE_COUNT)
    } else if (lineCount >= MAX_TEXT_LINE_COUNT) {
      setTextAreaRows(MAX_TEXT_LINE_COUNT)
    } else {
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
      <div
        className={`absolute transition-opacity duration-200 ease-in ${mobile ? ' top-12' : 'top-2'} ${loading ? 'opacity-0' : 'opacity-100'}`}
      >
        <div className='relative top-4 left-4 flex items-center gap-2'>
          <button
            type='button'
            onClick={handleClickNewChat}
            className='flex cursor-pointer items-center justify-center rounded-full bg-white p-2 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-600'
          >
            <NewChatIcon color='#5D5D5D' />
          </button>
          <button
            type='button'
            onClick={() => setShowMenu(!showMenu)}
            className='flex cursor-pointer items-center justify-center rounded-full bg-white p-2 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-600'
          >
            <GearIcon color='#5D5D5D' />
          </button>
        </div>
      </div>

      <div
        className={`fixed ${mobile ? ' top-30 left-4' : 'top-18 left-60 '} z-10 grid w-[300px] gap-2 rounded border bg-white p-2 shadow-xl ${!showMenu && 'hidden'}`}
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
          <span className='ml-1 text-md'>Temperature</span>
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
          placeholder='Max Tokens'
          onChange={handleChangeMaxTokens}
          className='w-full rounded-sm border border-gray-300 p-2 focus:outline-hidden focus:ring-2 focus:ring-blue-600'
        />
        <ToggleInput
          label='Markdown Preview'
          value={markdownPreview}
          onClick={handleClickShowMarkdownPreview}
        />
        <ToggleInput
          label='Interactive Mode'
          value={interactiveMode}
          onClick={handleClickInteractiveMode}
        />
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={
          emptyMessage
            ? `flex ${mobile ? 'h-[calc(100vh-56px)]' : 'h-screen'}`
            : `flex overflow-y-auto ${mobile ? 'h-[calc(100vh-56px)] max-h-[calc(100vh-162px-56px)]' : 'h-screen max-h-[calc(100vh-162px)]'}`
        }
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
                placeholder={loading ? 'しばらくお待ちください' : '質問してみよう！'}
                disabled={loading}
                rightBottom={
                  <SendButton
                    color={interactiveMode ? 'primary' : 'green'}
                    loading={loading}
                    disabled={loading || !!stream || input.trim().length <= 0}
                    handleClickStop={handleStreamCancel}
                  />
                }
                handleChangeInput={handleChangeInput}
                handleKeyDown={handleKeyDown}
                handleChangeComposition={handleChangeComposition}
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
                    <div className={'message mt-2 text-right'}>
                      <p
                        className={
                          'inline-block whitespace-pre-wrap rounded-t-3xl rounded-l-3xl bg-gray-100 px-4 py-2 text-left'
                        }
                      >
                        {content}
                      </p>
                    </div>
                  )}
                  {role === 'assistant' && (
                    <div className='mt-2 flex'>
                      <div className='flex h-[32px] justify-center rounded-full border-1 border-gray-300 align-center '>
                        <ChatbotIcon size={32} color='#5D5D5D' />
                      </div>
                      <div className='message text-left'>
                        {markdownPreview ? (
                          <div className='prose mt-1 ml-2'>
                            <Markdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>
                              {content}
                            </Markdown>
                          </div>
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
                <div className='mt-2 flex align-item'>
                  <div className='flex h-[32px] justify-center rounded-full border-1 border-gray-300 align-center '>
                    <ChatbotIcon size={32} color='#5D5D5D' />
                  </div>
                  {stream ? (
                    <div className='message text-left'>
                      {markdownPreview ? (
                        <div className='prose mt-1 ml-2'>
                          <Markdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>
                            {stream}
                          </Markdown>
                        </div>
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
            placeholder={loading ? 'しばらくお待ちください' : '質問してみよう！'}
            disabled={loading}
            rightBottom={
              <SendButton
                color={interactiveMode ? 'primary' : 'green'}
                loading={loading}
                disabled={loading || !!stream || input.trim().length <= 0}
                handleClickStop={handleStreamCancel}
              />
            }
            handleChangeInput={handleChangeInput}
            handleKeyDown={handleKeyDown}
            handleChangeComposition={handleChangeComposition}
          />
        )}
      </div>
    </form>
  )
}

interface SendButtonProps {
  color?: 'primary' | 'blue' | 'green'
  loading?: boolean
  disabled?: boolean
  handleClickStop?: () => void
}

function SendButton({ color = 'blue', loading, disabled, handleClickStop }: SendButtonProps) {
  const classes = useMemo(() => {
    switch (color) {
      case 'primary':
        return 'bg-gray-800 hover:bg-gray-500 disabled:hover:bg-gray-800'
      case 'blue':
        return 'bg-blue-400 hover:bg-blue-300 disabled:hover:bg-blue-400'
      case 'green':
        return 'bg-emerald-400 hover:bg-emerald-300 disabled:hover:bg-emerald-400'
      default:
        throw new Error(`Invalid color type: ${color}`)
    }
  }, [color])
  return (
    <>
      {loading ? (
        <button
          type='button'
          onClick={handleClickStop}
          className={`flex h-[32px] w-[32px] cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default`}
        >
          <StopIcon color='#ffffff' size={18} />
        </button>
      ) : (
        <button
          type='submit'
          disabled={disabled}
          className={`flex h-[32px] w-[32px] cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default`}
        >
          <ArrowUpIcon color='#ffffff' size={22} />
        </button>
      )}
    </>
  )
}
