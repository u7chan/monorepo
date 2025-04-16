import { hc } from 'hono/client'
import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  Fragment,
  type FC,
  type FormEvent,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import Markdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import remarkGfm from 'remark-gfm'

import type { AppType } from '@/server/app.d'

import { useResponsive } from '@/client/components/hooks/useResponsive'
import { ChatInput } from '@/client/components/input/ChatInput'
import { FileImageInput, FileImagePreview } from '@/client/components/input/FileImageInput'
import { ToggleInput } from '@/client/components/input/ToggleInput'
import { ArrowUpIcon } from '@/client/components/svg/ArrowUpIcon'
import { ChatbotIcon } from '@/client/components/svg/ChatbotIcon'
import { CheckIcon } from '@/client/components/svg/CheckIcon'
import { CopyIcon } from '@/client/components/svg/CopyIcon'
import { DeleteIcon } from '@/client/components/svg/DeleteIcon'
import { GearIcon } from '@/client/components/svg/GearIcon'
import { NewChatIcon } from '@/client/components/svg/NewChatIcon'
import { SpinnerIcon } from '@/client/components/svg/SpinnerIcon'
import { StopIcon } from '@/client/components/svg/StopIcon'
import { UploadIcon } from '@/client/components/svg/UploadIcon'

const client = hc<AppType>('/')

type Settings = {
  model: string
  baseURL: string
  apiKey: string
  temperature: string
  maxTokens: string
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
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

async function copyToClipboard(text: string) {
  if (navigator.clipboard) {
    // https only
    await navigator.clipboard.writeText(text)
  } else {
    const input = document.createElement('textarea')
    input.value = text
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
  }
}

type MarkdownLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement>

function MarkdownLink(props: MarkdownLinkProps) {
  const { href, children } = props as {
    href: string
    children: React.ReactNode
  }
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (href.startsWith('http')) {
      window.open(href, '_blank')
    } else {
      window.location.href = href
    }
  }
  return (
    <a href={href} onClick={handleClick} className='text-primary-800 underline'>
      {children}
    </a>
  )
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
function CodeBlock(props: any) {
  const [copied, setCopied] = useState(false)
  const { className = '', children = '' } = props as {
    className?: string
    children?: string
  }
  const language = className?.split('-')[1]
  if (!language) return <code>{children}</code>
  const handleClickCopy = async () => {
    setCopied(true)
    try {
      await copyToClipboard(children.trim())
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } catch (e) {
      alert(e)
    }
    setCopied(false)
  }
  return (
    <>
      <div className='flex justify-end'>
        <button
          type='button'
          onClick={handleClickCopy}
          disabled={copied}
          className='flex cursor-pointer gap-1 align-center'
        >
          {copied ? (
            <>
              <CheckIcon size={18} className='stroke-white' />
              <span className='text-xs'>コピーしました</span>
            </>
          ) : (
            <>
              <CopyIcon size={18} className='stroke-white' />
              <span className='text-xs'>コピーする</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter language={language}>{children}</SyntaxHighlighter>
    </>
  )
}

const MIN_TEXT_LINE_COUNT = 2
const MAX_TEXT_LINE_COUNT = 5

type MessageAssistant = {
  role: 'assistant'
  content: string
}

type MessageUser = {
  role: 'user'
  content:
    | string
    | (
        | {
            type: 'text'
            text: string
          }
        | {
            type: 'image_url'
            image_url: {
              url: string
            }
          }
      )[]
}

type Message = MessageAssistant | MessageUser

export const Chat: FC = () => {
  const formRef = useRef<HTMLFormElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomChatInputContainerRef = useRef<HTMLDivElement>(null)
  const [bottomChatInputContainerHeight, setbottomChatInputContainerHeight] = useState(0)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const { mobile } = useResponsive()

  const defaultSettings = useMemo(() => {
    return readFromLocalStorage()
  }, [])

  const [messages, setMessages] = useState<Message[]>([])
  const [copiedId, setCopiedId] = useState('')
  const [stream, setStream] = useState('')
  const [chatResults, setChatResults] = useState<{
    model?: string
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    } | null
  } | null>(null)
  const [input, setInput] = useState('')
  const [uploadImage, setUploadImage] = useState('')
  const [temperature, setTemperature] = useState<number>(
    defaultSettings.temperature ? Number(defaultSettings.temperature) : 0.7,
  )
  const [fakeMode, setFakeMode] = useState(defaultSettings?.fakeMode ?? false)
  const [markdownPreview, setMarkdownPreview] = useState(defaultSettings?.markdownPreview ?? true)
  const [streamMode, setStreamMode] = useState(defaultSettings?.streamMode ?? true)
  const [interactiveMode, setInteractiveMode] = useState(defaultSettings?.interactiveMode ?? true)
  const [textAreaRows, setTextAreaRows] = useState(MIN_TEXT_LINE_COUNT)
  const [composing, setComposition] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [loading, setLoading] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    scrollContainerRef?.current?.addEventListener('click', handleClickScrollContainer)
    bottomChatInputContainerRef?.current?.addEventListener('click', handleClickScrollContainer)

    const buttomChatInputContainerObserver = new ResizeObserver(([element]) => {
      setbottomChatInputContainerHeight(element.contentRect.height)
    })

    if (bottomChatInputContainerRef?.current) {
      buttomChatInputContainerObserver.observe(bottomChatInputContainerRef?.current)
    }

    return () => {
      scrollContainerRef?.current?.removeEventListener('click', handleClickScrollContainer)
      bottomChatInputContainerRef?.current?.removeEventListener('click', handleClickScrollContainer)

      if (bottomChatInputContainerRef?.current) {
        buttomChatInputContainerObserver.unobserve(bottomChatInputContainerRef?.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!loading) return
    messageEndRef?.current?.scrollIntoView({ behavior: 'smooth' })
  }, [loading])

  useEffect(() => {
    if (!autoScroll) return
    messageEndRef?.current?.scrollIntoView(!streamMode && { behavior: 'smooth' })
  }, [stream, chatResults, streamMode, markdownPreview, autoScroll, bottomChatInputContainerHeight])

  const handleScroll = () => {
    if (!scrollContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    const threshold = 36
    if (scrollTop + clientHeight >= scrollHeight - threshold) {
      setAutoScroll(true)
    } else {
      setAutoScroll(false)
    }
  }

  const handleClickNewChat = () => {
    setShowMenu(false)
    setMessages([])
    setInput('')
    setUploadImage('')
    setTextAreaRows(MIN_TEXT_LINE_COUNT)
  }

  const handleClickScrollContainer = () => {
    setShowMenu(false)
  }

  const handleChangeModel = (event: ChangeEvent<HTMLInputElement>) => {
    saveToLocalStorage({ model: event.target.value })
  }

  const handleChangeBaseURL = (event: ChangeEvent<HTMLInputElement>) => {
    saveToLocalStorage({ baseURL: event.target.value })
  }

  const handleChangeApiKey = (event: ChangeEvent<HTMLInputElement>) => {
    saveToLocalStorage({ apiKey: event.target.value })
  }

  const handleChangeTemperature = (event: ChangeEvent<HTMLInputElement>) => {
    setTemperature(Number.parseFloat(event.target.value))
    saveToLocalStorage({ temperature: event.target.value })
  }

  const handleChangeMaxTokens = (event: ChangeEvent<HTMLInputElement>) => {
    saveToLocalStorage({ maxTokens: event.target.value })
  }

  const handleClickFakeMode = () => {
    const newFakeMode = !fakeMode
    setFakeMode(newFakeMode)
    saveToLocalStorage({ fakeMode: newFakeMode })
  }

  const handleClickShowMarkdownPreview = () => {
    const newMarkdownPreview = !markdownPreview
    setMarkdownPreview(newMarkdownPreview)
    saveToLocalStorage({ markdownPreview: newMarkdownPreview })
  }

  const handleClickStreamMode = () => {
    const newStreamMode = !streamMode
    setStreamMode(newStreamMode)
    saveToLocalStorage({ streamMode: newStreamMode })
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

  const handleUploadImageChange = (src: string) => {
    setUploadImage(src)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const form = {
      model: fakeMode ? 'fakemode' : formData.get('model')?.toString() || '',
      baseURL: fakeMode ? 'fakemode' : formData.get('baseURL')?.toString() || '',
      apiKey: fakeMode ? 'fakemode' : formData.get('apiKey')?.toString() || '',
      temperature: Number(formData.get('temperature')),
      maxTokens: formData.get('maxTokens') ? Number(formData.get('maxTokens')) : undefined,
      userInput: formData.get('userInput')?.toString() || '',
    }
    if (!form.userInput.trim()) {
      return
    }

    const userMessage: Message = {
      role: 'user',
      content: uploadImage
        ? [
            {
              type: 'text',
              text: form.userInput,
            },
            {
              type: 'image_url',
              image_url: {
                url: uploadImage,
              },
            },
          ]
        : form.userInput,
    }
    const newMessages = [...messages, userMessage]

    setShowMenu(false)
    setLoading(true)
    setMessages(newMessages)
    setInput('')
    setUploadImage('')
    setTextAreaRows(MIN_TEXT_LINE_COUNT)
    setChatResults(null)

    let result = ''
    let usage: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    } | null = null
    let model = 'N/A'

    // Call the Chat API
    abortControllerRef.current = new AbortController()

    // TODO: [!] Cognitive Complexity
    try {
      const res = await client.api.chat.$post(
        {
          header: {
            'api-key': form.apiKey,
            'base-url': form.baseURL,
          },
          json: {
            messages: interactiveMode ? newMessages : [userMessage],
            model: form.model,
            stream: streamMode,
            temperature: form.temperature,
            max_tokens: form.maxTokens,
            stream_options: streamMode
              ? {
                  include_usage: true,
                }
              : undefined,
          },
        },
        { init: { signal: abortControllerRef.current.signal } },
      )
      if (!res.ok) {
        const error = (await res.json()) as unknown as { message?: string }
        result = error?.message || JSON.stringify(error)
      } else {
        const nonStream = res.headers.get('Content-Type') === 'application/json'
        if (nonStream) {
          const data = (await res.json()) as unknown as {
            choices: { message: { content: string } }[]
            model?: string
            usage?: {
              prompt_tokens: number
              completion_tokens: number
              total_tokens: number
            }
          }
          result = data.choices[0].message.content
          model = data?.model || 'N/A'
          usage = data?.usage ?? null
        } else {
          const reader = res.body?.getReader()
          const decoder = new TextDecoder('utf-8')
          while (true) {
            const stream = await reader?.read()
            if (stream?.done || !!stream?.done) {
              break
            }
            if (!stream?.value) {
              continue
            }
            const chunk = decoder.decode(stream.value, { stream: true })
            const chunkJSONs = chunk
              .replaceAll('data: ', '')
              .split('\n')
              .filter((x) => x && x !== '[DONE]')
              .map((x) => JSON.parse(x))
            // Append chunk to result
            result += chunkJSONs.map((x) => x.choices.at(0)?.delta?.content).join('')

            const _model = chunkJSONs.find((x) => x.model)?.model ?? null
            if (_model) {
              model = _model
            }
            const _usage = chunkJSONs.find((x) => x.usage)?.usage ?? null
            if (_usage) {
              usage = _usage
            }
            setStream(`${result}●`)
          }
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
      setChatResults({
        model,
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
    <form ref={formRef} onSubmit={handleSubmit}>
      <div
        className={`absolute transition-opacity duration-200 ease-in ${mobile ? ' top-12' : 'top-2'} ${loading ? 'opacity-0' : 'opacity-100'}`}
      >
        <div className='relative top-4 left-4 flex items-center gap-2'>
          <button
            type='button'
            onClick={handleClickNewChat}
            className='flex cursor-pointer items-center justify-center rounded-full bg-white p-2 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400'
          >
            <NewChatIcon className='fill-[#5D5D5D]' />
          </button>
          <button
            type='button'
            onClick={() => setShowMenu(!showMenu)}
            className='flex cursor-pointer items-center justify-center rounded-full bg-white p-2 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400'
          >
            <GearIcon className='fill-[#5D5D5D]' />
          </button>
        </div>
      </div>
      <div
        className={`fixed ${mobile ? ' top-30 left-4' : 'top-18 left-60 '} z-10 grid w-[300px] gap-2 rounded border bg-white p-2 shadow-xl ${!showMenu && 'hidden'}`}
      >
        <div className='flex items-center justify-between gap-2'>
          <span className={`ml-1 w-[154px] font-medium text-sm ${fakeMode ? 'opacity-50' : ''}`}>
            Model
          </span>
          <input
            name='model'
            defaultValue={defaultSettings.model || 'gpt-4.1-mini'}
            disabled={fakeMode}
            onChange={handleChangeModel}
            placeholder='model'
            className={`w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <div className='flex items-center gap-2'>
          <span className={`ml-1 w-[154px] font-medium text-sm ${fakeMode ? 'opacity-50' : ''}`}>
            BaseURL
          </span>
          <input
            name='baseURL'
            defaultValue={defaultSettings.baseURL || 'https://api.openai.com/v1'}
            disabled={fakeMode}
            onChange={handleChangeBaseURL}
            className={`w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <div className='flex items-center gap-2'>
          <span className={`ml-1 w-[154px] font-medium text-sm ${fakeMode ? 'opacity-50' : ''}`}>
            API KEY
          </span>
          <input
            name='apiKey'
            type='password'
            disabled={fakeMode}
            defaultValue={defaultSettings.apiKey}
            onChange={handleChangeApiKey}
            className={`w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400 ${fakeMode ? 'cursor-not-allowed opacity-50' : ''}`}
          />
        </div>
        <ToggleInput label='Fake Mode' value={fakeMode} onClick={handleClickFakeMode} />
        <div className='flex items-center gap-2'>
          <span className='ml-1 w-[154px] font-medium text-sm'>Temperature</span>
          <div className='flex w-full items-center gap-2'>
            <input
              name='temperature'
              type='range'
              min='0'
              max='1'
              step='0.01'
              value={temperature}
              onChange={handleChangeTemperature}
              disabled={!!stream}
              className='range-slider h-2 w-full cursor-pointer appearance-none rounded-lg bg-primary-400 accent-primary-800'
            />
            <div className='mr-1 text-sm'>{temperature.toFixed(2)}</div>
          </div>
        </div>
        <div className='flex items-center justify-between gap-2'>
          <span className='ml-1 w-[154px] font-medium text-sm'>Max Tokens</span>
          <input
            name='maxTokens'
            type='number'
            min={1}
            max={4096}
            defaultValue={defaultSettings.maxTokens}
            onChange={handleChangeMaxTokens}
            className='w-full rounded-sm border border-gray-300 px-2 py-1 focus:outline-hidden focus:ring-2 focus:ring-gray-400'
          />
        </div>
        <ToggleInput
          label='Markdown Preview'
          value={markdownPreview}
          onClick={handleClickShowMarkdownPreview}
        />
        <ToggleInput label='Stream Mode' value={streamMode} onClick={handleClickStreamMode} />
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
            : 'flex h-calc overflow-y-auto'
        }
        style={
          {
            '--height': mobile
              ? `${56 + bottomChatInputContainerHeight}px`
              : `${bottomChatInputContainerHeight}px`,
          } as never
        }
      >
        {emptyMessage && (
          <div className='container mx-auto flex max-w-screen-lg flex-1 items-center justify-center'>
            <div className='grid flex-1 gap-3'>
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
                leftBottom={
                  <FileImagePreview src={uploadImage} onImageChange={handleUploadImageChange}>
                    <FileImageInput
                      fileInputButton={(onClick) => (
                        <button
                          type='button'
                          onClick={onClick}
                          disabled={loading || !!stream}
                          className='flex cursor-pointer items-center gap-0.5 rounded-3xl border bg-white px-2 py-1 text-black hover:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:text-gray-300 disabled:hover:cursor-default disabled:hover:bg-white'
                        >
                          <UploadIcon className={loading || stream ? 'fill-gray-300' : undefined} />
                          <div className='text-sm'>画像</div>
                        </button>
                      )}
                      onImageChange={handleUploadImageChange}
                    />
                  </FileImagePreview>
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
              {messages.map(({ role, content }, index) => {
                const copied = copiedId === `chat_${index}`
                const handleClickCopy = async (message: string) => {
                  setCopiedId(`chat_${index}`)
                  try {
                    await copyToClipboard(message)
                    await new Promise((resolve) => setTimeout(resolve, 3000))
                  } catch (e) {
                    alert(e)
                  }
                  setCopiedId('')
                }
                const handleClickDelete = (i: number) => {
                  if (confirm('本当に削除しますか？')) {
                    setMessages((prevMessages) => {
                      const newMessage = [...prevMessages]
                      newMessage.splice(i, 1) // user
                      newMessage.splice(i, 1) // assistant
                      return newMessage
                    })
                  }
                }
                return (
                  <React.Fragment key={`chat_${index}`}>
                    {role === 'user' && (
                      <div className={'message mt-2 text-right'}>
                        <div className='group'>
                          <div
                            className={
                              'inline-block whitespace-pre-wrap rounded-t-3xl rounded-l-3xl bg-gray-100 px-4 py-2 text-left'
                            }
                          >
                            {typeof content === 'string' ? (
                              content
                            ) : (
                              <>
                                {content.map((value, i) => {
                                  return (
                                    <Fragment key={`${i}`}>
                                      <div>{value.type === 'text' && value.text}</div>
                                      {value.type === 'image_url' && (
                                        <img
                                          src={value.image_url.url}
                                          alt='upload-img'
                                          className='my-1 max-w-3xs border'
                                        />
                                      )}
                                    </Fragment>
                                  )
                                })}
                              </>
                            )}
                          </div>
                          <div
                            className={`mt-1 ml-1 transition-opacity duration-200 ease-in group-hover:opacity-100 ${copied ? 'opacity-100' : 'opacity-0'} ${loading || stream ? 'hidden' : ''}`}
                          >
                            <button
                              type='button'
                              className='cursor-pointer p-1'
                              onClick={() =>
                                handleClickCopy(typeof content === 'string' ? content : '')
                              }
                              disabled={copied}
                            >
                              {copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
                            </button>
                            <button
                              type='button'
                              className='cursor-pointer p-1'
                              onClick={() => handleClickDelete(index)}
                            >
                              <DeleteIcon size={20} />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {role === 'assistant' && (
                      <div className='flex'>
                        {!mobile && (
                          <div className='flex h-[32px] justify-center rounded-full border-1 border-gray-300 align-center '>
                            <ChatbotIcon size={32} className='stroke-[#5D5D5D]' />
                          </div>
                        )}
                        <div className='message group text-left '>
                          {markdownPreview ? (
                            <div className='prose mt-1 ml-2'>
                              <Markdown
                                remarkPlugins={[remarkGfm]}
                                components={{ a: MarkdownLink, code: CodeBlock }}
                              >
                                {content}
                              </Markdown>
                            </div>
                          ) : (
                            <div className='message text-left'>
                              <p className='mt-1 ml-2 inline-block whitespace-pre-wrap'>
                                {content}
                              </p>
                            </div>
                          )}
                          <div
                            className={`mt-1 ml-1 transition-opacity duration-200 ease-in group-hover:opacity-100 ${copied ? 'opacity-100' : 'opacity-0'}`}
                          >
                            <button
                              type='button'
                              className='cursor-pointer p-1'
                              onClick={() => handleClickCopy(content)}
                              disabled={copied}
                            >
                              {copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </React.Fragment>
                )
              })}
              {loading && (
                <div className='flex align-item'>
                  {!mobile && (
                    <div className='flex h-[32px] justify-center rounded-full border-1 border-gray-300 align-center '>
                      <ChatbotIcon size={32} className='stroke-[#5D5D5D]' />
                    </div>
                  )}
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

              {!loading && chatResults?.usage && (
                <div className='mt-2 flex justify-end gap-1'>
                  <div className='flex items-center gap-2 rounded-md bg-gray-100 px-2 py-1 text-xs'>
                    <span>{chatResults.model}</span>
                  </div>
                  <div className='flex items-center gap-2 rounded-md bg-gray-100 px-2 py-1 text-xs'>
                    <div>
                      <span className='mr-1'>Input:</span>
                      <span>{chatResults.usage?.promptTokens}</span>
                    </div>
                    <div>
                      <span className='mr-1'>Output:</span>
                      <span>{chatResults.usage?.completionTokens}</span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messageEndRef} className='h-4' />
            </div>
          </div>
        )}
      </div>

      <div ref={bottomChatInputContainerRef} className='container mx-auto max-w-screen-lg'>
        {!emptyMessage && (
          <>
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
              leftBottom={
                <FileImagePreview src={uploadImage} onImageChange={handleUploadImageChange}>
                  <FileImageInput
                    fileInputButton={(onClick) => (
                      <button
                        type='button'
                        onClick={onClick}
                        disabled={loading || !!stream}
                        className='flex cursor-pointer items-center gap-0.5 rounded-3xl border bg-white px-2 py-1 text-black hover:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:text-gray-300 disabled:hover:cursor-default disabled:hover:bg-white'
                      >
                        <UploadIcon className={loading || stream ? 'fill-gray-300' : undefined} />
                        <div className='text-sm'>画像</div>
                      </button>
                    )}
                    onImageChange={handleUploadImageChange}
                  />
                </FileImagePreview>
              }
              handleChangeInput={handleChangeInput}
              handleKeyDown={handleKeyDown}
              handleChangeComposition={handleChangeComposition}
            />
            <div className='h-4' />
          </>
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
        return 'bg-primary-800 hover:bg-primary-700 disabled:hover:bg-primary-800'
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
          <StopIcon className='fill-white' size={18} />
        </button>
      ) : (
        <button
          type='submit'
          disabled={disabled}
          className={`flex h-[32px] w-[32px] cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default`}
        >
          <ArrowUpIcon className='fill-white' size={22} />
        </button>
      )}
    </>
  )
}
