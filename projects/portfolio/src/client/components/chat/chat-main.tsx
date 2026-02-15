import { ChatInput } from '#/client/components/chat/chat-input'
import { PromptTemplate, type TemplateInput } from '#/client/components/chat/prompt-template'
import { FileImageInput, FileImagePreview } from '#/client/components/input/file-image-input'
import { ArrowUpIcon } from '#/client/components/svg/arrow-upIcon'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { DeleteIcon } from '#/client/components/svg/delete-icon'
import { SpinnerIcon } from '#/client/components/svg/spinner-icon'
import { StopIcon } from '#/client/components/svg/stop-icon'
import { UploadIcon } from '#/client/components/svg/upload-icon'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { AppType } from '#/server/app.d'
import type { Conversation } from '#/types'
import { hc } from 'hono/client'
import React, {
  type ChangeEvent,
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import remarkGfm from 'remark-gfm'
import { uuidv7 } from 'uuidv7'

const client = hc<AppType>('/')

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

function MarkdownLink({ href, children }: MarkdownLinkProps) {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (!href) {
      return
    }
    if (href.startsWith('http')) {
      window.open(href, '_blank')
    } else {
      window.location.href = href
    }
  }
  return (
    <a href={href} onClick={handleClick} className='text-primary-800 underline dark:text-primary-400'>
      {children}
    </a>
  )
}

type MarkdownCodeBlockProps = React.HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode | string
}

function MarkdownCodeBlock({ className, children }: MarkdownCodeBlockProps) {
  const isDarkMode = document.documentElement.classList.contains('dark')
  const [copied, setCopied] = useState(false)
  const code = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''

  const language = className?.split('-')[1]

  if (typeof children !== 'string' || !language) {
    return <code>{children}</code>
  }

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
              <span className='text-white text-xs'>コピーしました</span>
            </>
          ) : (
            <>
              <CopyIcon size={18} className='stroke-white' />
              <span className='text-white text-xs'>コピーする</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter style={isDarkMode ? atomDark : undefined} language={language}>
        {code}
      </SyntaxHighlighter>
    </>
  )
}

const MIN_TEXT_LINE_COUNT = 2
const MAX_TEXT_LINE_COUNT = 5

type MessageAssistant = {
  role: 'assistant'
  content: string
  reasoning_content?: string
}

type MessageSystem = {
  role: 'system'
  content: string
}

type MessageUser = {
  role: 'user'
  content:
    | string
    | Array<
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
      >
}

type Message = MessageSystem | MessageAssistant | MessageUser

interface Props {
  initTrigger?: number
  settings: Settings
  currentConversation?: Conversation | null
  onSubmitting?: (submitting: boolean) => void
  onConversationChange?: (conversation: Conversation) => void
  onDeleteMessages?: (messageIds: string[], isConversationEmpty: boolean) => void
}

export function ChatMain({
  initTrigger,
  settings,
  currentConversation,
  onSubmitting,
  onConversationChange,
  onDeleteMessages,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomChatInputContainerRef = useRef<HTMLDivElement>(null)
  const [bottomChatInputContainerHeight, setbottomChatInputContainerHeight] = useState(0)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [copiedId, setCopiedId] = useState('')
  const [stream, setStream] = useState<{
    content: string
    reasoning_content?: string
  } | null>(null)
  const [chatResults, setChatResults] = useState<{
    model?: string
    finish_reason: string
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    } | null
  } | null>(null)
  const [input, setInput] = useState('')
  const [templateInput, setTemplateInput] = useState<TemplateInput | null>(null)
  const [uploadImages, setUploadImages] = useState<string[]>([])
  const [textAreaRows, setTextAreaRows] = useState(MIN_TEXT_LINE_COUNT)
  const [composing, setComposition] = useState(false)
  const [loading, setLoading] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    setMessages([])
    setConversationId(null)
    setChatResults(null)
    setInput('')
    setUploadImages([])
    setTextAreaRows(MIN_TEXT_LINE_COUNT)
  }, [initTrigger])

  // 選択された会話のメッセージを設定
  useEffect(() => {
    if (!currentConversation) {
      return
    }

    // 会話が選択された時、そのメッセージを設定
    const convertedMessages: Message[] = currentConversation.messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
      reasoning_content: msg.reasoningContent,
    }))
    setConversationId(currentConversation.id)
    setMessages(convertedMessages)
    setChatResults(null)
    setTimeout(() => {
      // メッセージの末尾にスクロール
      messageEndRef?.current?.scrollIntoView({
        behavior: 'instant',
        block: 'end',
      })
    }, 0)
  }, [currentConversation])

  useEffect(() => {
    const buttomChatInputContainerObserver = new ResizeObserver(([element]) => {
      setbottomChatInputContainerHeight(element.contentRect.height)
    })

    if (bottomChatInputContainerRef?.current) {
      buttomChatInputContainerObserver.observe(bottomChatInputContainerRef?.current)
    }

    return () => {
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
    messageEndRef?.current?.scrollIntoView(!settings.streamMode && { behavior: 'smooth' })
  }, [stream, chatResults, settings, autoScroll, bottomChatInputContainerHeight])

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

  const handleStreamCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }

  const handleUploadImageChange = (src: string, index?: number) => {
    if (!src && index !== undefined) {
      // pop
      if (uploadImages.length === 1) {
        setUploadImages([])
      } else {
        setUploadImages((pre) => pre.filter((_, idx) => idx !== index))
      }
    } else {
      // push
      setUploadImages([...uploadImages, src])
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const form = {
      model: settings.fakeMode ? 'fakemode' : settings.model,
      baseURL: settings.fakeMode ? 'fakemode' : settings.baseURL,
      apiKey: settings.fakeMode ? 'fakemode' : settings.apiKey,
      mcpServerURLs: settings.fakeMode ? '' : settings.mcpServerURLs,
      temperature: settings.temperatureEnabled ? settings.temperature : undefined,
      maxTokens: settings.maxTokens ? Number(settings.maxTokens) : undefined,
      userInput: formData.get('userInput')?.toString() || '',
    }
    const options = {
      interactiveMode: settings.interactiveMode,
      messages,
      uploadImages,
    }

    const inputText = form.userInput.trim()
    const params = templateInput
      ? createTemplateMessage(templateInput, form.model, options)
      : createMessage(inputText, form.model, options)
    if (!params) {
      return
    }

    setLoading(true)
    setMessages(messages.length === 0 ? [...messages, ...params.messages] : params.messages)
    setInput('')
    setTemplateInput(null)
    setUploadImages([])
    setTextAreaRows(MIN_TEXT_LINE_COUNT)
    setChatResults(null)

    abortControllerRef.current = new AbortController()

    onSubmitting?.(true)
    sendChatCompletion({
      abortController: abortControllerRef.current,
      header: {
        apiKey: form.apiKey,
        baseURL: form.baseURL,
        mcpServerURLs: form.mcpServerURLs,
      },
      model: params.model,
      messages: params.messages,
      stream: settings.streamMode,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      onStream: (stream) => {
        setStream(stream)
      },
    }).then((result) => {
      const userInput = params.messages?.at(-1)?.content
      const newConversationMessages = [
        // TODO: append system message
        {
          role: 'user' as const,
          content: typeof userInput === 'string' ? userInput : '',
          reasoningContent: '',
          metadata: {
            model: params.model,
            stream: settings.streamMode,
            temperature: form.temperature,
            maxTokens: form.maxTokens,
          },
        },
        ...(result
          ? [
              {
                role: 'assistant' as const,
                content: result.message.content,
                reasoningContent: result.message.reasoning_content,
                metadata: {
                  model: result.model,
                  finishReason: result.finish_reason,
                  usage: {
                    promptTokens: result.usage?.promptTokens || 0,
                    completionTokens: result.usage?.completionTokens || 0,
                    totalTokens: result.usage?.totalTokens || 0,
                    reasoningTokens: result.usage?.reasoningTokens,
                  },
                },
              },
            ]
          : []),
      ]

      // 会話IDが指定されていない場合は会話IDを新規作成
      const currentConversationId =
        conversationId ||
        (() => {
          const newConversationId = uuidv7()
          setConversationId(newConversationId)
          return newConversationId
        })()

      // 親コンポーネントに更新されたメッセージを通知
      onConversationChange?.({
        id: currentConversationId,
        title: typeof userInput === 'string' ? userInput.slice(0, 10) : '',
        messages: newConversationMessages,
      })

      if (result) {
        const newMessages = [
          ...(messages.length === 0 ? [...messages, ...params.messages] : params.messages),
          {
            role: 'assistant' as const,
            ...result.message,
          },
        ]
        setMessages(newMessages)
        setChatResults({
          model: result.model,
          finish_reason: result.finish_reason,
          usage: result.usage,
        })
      }
      setStream(null)
      setLoading(false)
      onSubmitting?.(false)
    })
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
    const content = event.currentTarget.value.trim()
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      if (content && formRef.current) {
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
      {emptyMessage && (
        <div className='flex h-full items-center justify-center'>
          <div className='container mx-auto flex max-w-(--breakpoint-lg) flex-1 items-center justify-center'>
            <div className='grid flex-1 gap-3'>
              <div className={'mb-2 text-center font-bold text-2xl text-gray-700 sm:text-3xl dark:text-gray-200'}>
                お手伝いできることはありますか？
              </div>
              <PromptTemplate
                placeholder={settings.model}
                onSubmit={(templateInput) => {
                  setTemplateInput(templateInput)
                  formRef?.current?.requestSubmit()
                }}
              />
              <ChatInput
                name='userInput'
                value={input}
                textAreaRows={textAreaRows}
                placeholder={loading ? 'しばらくお待ちください' : '質問してみよう！'}
                disabled={loading}
                rightBottom={
                  <SendButton
                    color={settings.interactiveMode ? 'primary' : 'green'}
                    loading={loading}
                    disabled={loading || !!stream || input.trim().length <= 0}
                    handleClickStop={handleStreamCancel}
                  />
                }
                leftBottom={
                  <FileImagePreview src={uploadImages} onImageChange={handleUploadImageChange}>
                    <FileImageInput
                      fileInputButton={(onClick) => (
                        <button
                          type='button'
                          onClick={onClick}
                          disabled={loading || !!stream}
                          className='group flex cursor-pointer items-center gap-0.5 rounded-3xl border border-gray-200 bg-white px-2 py-1 transition-colors hover:bg-gray-100 focus:border-primary-700 focus:outline-none focus:ring-0.5 disabled:opacity-50 disabled:hover:cursor-default disabled:hover:bg-white dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:disabled:hover:bg-gray-700'
                        >
                          <UploadIcon size={20} className='fill-gray-500 group-disabled:fill-gray-300' />
                          <div className='hidden sm:block mr-0.5 text-gray-500 text-xs group-disabled:text-gray-300 dark:text-gray-400 dark:group-disabled:text-gray-500'>
                            画像アップロード
                          </div>
                        </button>
                      )}
                      onImageChange={handleUploadImageChange}
                    />
                  </FileImagePreview>
                }
                onChangeInput={handleChangeInput}
                onKeyDown={handleKeyDown}
                onChangeComposition={handleChangeComposition}
              />
              <div className='py-4' />
            </div>
          </div>
        </div>
      )}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={emptyMessage ? 'hidden' : 'h-calc overflow-y-auto'}
        style={
          {
            '--height': `${bottomChatInputContainerHeight}px`,
          } as never
        }
      >
        {!emptyMessage && (
          <div className='container mx-auto mt-4 max-w-(--breakpoint-lg) px-4'>
            <div className='message-list'>
              {messages.map((message, index) => {
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
                    let isConversationEmpty = false
                    setMessages((prevMessages) => {
                      const newMessages = [...prevMessages]
                      newMessages.splice(i, 1) // user
                      newMessages.splice(i, 1) // assistant
                      isConversationEmpty = newMessages.length <= 0
                      return newMessages
                    })
                    const deleteMessageIds = [
                      currentConversation?.messages?.at(i)?.id,
                      currentConversation?.messages?.at(i + 1)?.id,
                    ].filter((x): x is string => x !== undefined)
                    onDeleteMessages?.(deleteMessageIds, isConversationEmpty)
                  }
                }
                return (
                  <React.Fragment key={`chat_${index}`}>
                    {message.role === 'user' && (
                      <div className={'message mt-2 text-right'}>
                        <div className='group'>
                          <div
                            className={
                              'inline-block whitespace-pre-wrap break-all rounded-t-3xl rounded-l-3xl bg-gray-100 px-4 py-2 text-left dark:bg-gray-600 dark:text-white'
                            }
                          >
                            {typeof message.content === 'string'
                              ? message.content
                              : message.content.map((value, i) => {
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
                          </div>
                          <div
                            className={`mt-1 ml-1 transition-opacity duration-200 ease-in group-hover:opacity-100 ${copied ? 'opacity-100' : 'opacity-0'} ${loading || stream ? 'invisible' : ''}`}
                          >
                            <button
                              type='button'
                              className='cursor-pointer p-1'
                              onClick={() =>
                                handleClickCopy(typeof message.content === 'string' ? message.content : '')
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
                    {message.role === 'assistant' && (
                      <div className='flex'>
                        <div className='flex h-8 w-8 justify-center rounded-full border border-gray-300 bg-white align-center dark:border-gray-600 dark:bg-gray-900'>
                          <ChatbotIcon size={32} className='stroke-gray-600 dark:stroke-gray-300' />
                        </div>
                        <div className='message group ml-2 text-left'>
                          {message.reasoning_content && (
                            <div className='wrap-break-word whitespace-pre-line break-all text-gray-400 text-xs dark:text-gray-200'>
                              {message.reasoning_content}
                            </div>
                          )}
                          {settings.markdownPreview ? (
                            <div className='prose mt-1 max-w-(--breakpoint-md) break-all'>
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  a: MarkdownLink,
                                  code: MarkdownCodeBlock,
                                }}
                              >
                                {message.content}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <div className='message text-left'>
                              <p className='wrap-break-word mt-1 inline-block whitespace-pre-wrap break-all'>
                                {message.content}
                              </p>
                            </div>
                          )}
                          <div
                            className={`mt-1 ml-1 transition-opacity duration-200 ease-in group-hover:opacity-100 ${copied ? 'opacity-100' : 'opacity-0'}`}
                          >
                            <button
                              type='button'
                              className='cursor-pointer p-1'
                              onClick={() => handleClickCopy(message.content)}
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
                  <div className='flex h-8 w-8 justify-center rounded-full border border-gray-300 bg-white align-center dark:border-gray-600 dark:bg-gray-900'>
                    <ChatbotIcon size={32} className='stroke-gray-600 dark:stroke-gray-300' />
                  </div>
                  {stream ? (
                    <div className='message ml-2 text-left'>
                      {stream.reasoning_content && (
                        <div className='wrap-break-word whitespace-pre-line break-all text-gray-400 text-xs dark:text-gray-200'>
                          {stream.reasoning_content}
                        </div>
                      )}
                      {settings.markdownPreview ? (
                        <div className='prose mt-1 max-w-(--breakpoint-md) break-all dark:text-white'>
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: MarkdownLink,
                              code: MarkdownCodeBlock,
                            }}
                          >
                            {stream.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <div className='message text-left'>
                          <p className='wrap-break-word mt-1 inline-block whitespace-pre-wrap break-all'>
                            {stream.content}
                          </p>
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
              {!loading && chatResults && (
                <div className='mt-2 flex justify-end gap-1'>
                  <div className='flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'>
                    <span className='mr-1'>model:</span>
                    <span>{chatResults.model}</span>
                  </div>
                  {chatResults.finish_reason && (
                    <div className='flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'>
                      <span className='mr-1'>finish_reason:</span>
                      <span>{chatResults.finish_reason}</span>
                    </div>
                  )}
                  <div className='flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'>
                    <span className='mr-1'>usage:</span>
                    <span className='mr-0.5'>(input:</span>
                    <span>{chatResults.usage?.promptTokens || '--'}</span>
                    <span className='mr-0.5'>/</span>
                    <span className='mr-0.5'>output:</span>
                    <span>{chatResults.usage?.completionTokens || '--'}</span>
                    <span>)</span>
                  </div>
                </div>
              )}
              <div ref={messageEndRef} className='h-4' />
            </div>
          </div>
        )}
      </div>

      <div ref={bottomChatInputContainerRef} className='container mx-auto max-w-(--breakpoint-lg)'>
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
                  color={settings.interactiveMode ? 'primary' : 'green'}
                  loading={loading}
                  disabled={loading || !!stream || input.trim().length <= 0}
                  handleClickStop={handleStreamCancel}
                />
              }
              leftBottom={
                <FileImagePreview src={uploadImages} onImageChange={handleUploadImageChange}>
                  <FileImageInput
                    fileInputButton={(onClick) => (
                      <button
                        type='button'
                        onClick={onClick}
                        disabled={loading || !!stream}
                        className='group flex cursor-pointer items-center gap-0.5 rounded-3xl border border-gray-200 bg-white px-2 py-1 transition-colors hover:bg-gray-100 focus:border-primary-700 focus:outline-none focus:ring-0.5 disabled:opacity-50 disabled:hover:cursor-default disabled:hover:bg-white'
                      >
                        <UploadIcon size={20} className='fill-gray-500 group-disabled:fill-gray-300' />
                        <div className='hidden sm:block mr-0.5 text-gray-500 text-xs group-disabled:text-gray-300'>
                          画像アップロード
                        </div>
                      </button>
                    )}
                    onImageChange={handleUploadImageChange}
                  />
                </FileImagePreview>
              }
              onChangeInput={handleChangeInput}
              onKeyDown={handleKeyDown}
              onChangeComposition={handleChangeComposition}
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
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700`}
        >
          <StopIcon className='fill-white' size={18} />
        </button>
      ) : (
        <button
          type='submit'
          disabled={disabled}
          className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full ${classes} focus:outline-hidden focus:ring-2 focus:ring-gray-400 disabled:cursor-default dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700`}
        >
          <ArrowUpIcon className='fill-white' size={22} />
        </button>
      )}
    </>
  )
}

const createMessage = (
  inputText: string,
  model: string,
  { interactiveMode, messages, uploadImages }: { interactiveMode: boolean; messages: Message[]; uploadImages: string[] }
): {
  model: string
  messages: Message[]
} | null => {
  if (!inputText) {
    return null
  }
  const userMessage: MessageUser = {
    role: 'user',
    content:
      uploadImages.length > 0
        ? [
            {
              type: 'text' as const,
              text: inputText,
            },
            ...uploadImages.map((image) => ({
              type: 'image_url' as const,
              image_url: {
                url: image,
              },
            })),
          ]
        : inputText,
  }
  const newMessages: Message[] = [...messages, userMessage]
  return {
    model,
    messages: interactiveMode ? newMessages : [userMessage],
  }
}

const createTemplateMessage = (
  templateInput: TemplateInput,
  model: string,
  { interactiveMode, messages }: { interactiveMode: boolean; messages: Message[] }
): {
  model: string
  messages: Message[]
} => {
  const userMessage: MessageUser = {
    role: 'user',
    content: templateInput.content,
  }
  const systemMessage: Message = {
    role: 'system',
    content: templateInput.prompt,
  }
  const newMessages: Message[] =
    messages.length === 0 && templateInput ? [systemMessage, userMessage] : [...messages, userMessage]
  return {
    model: templateInput.model || model,
    messages: interactiveMode ? newMessages : [systemMessage, userMessage],
  }
}

const sendChatCompletion = async (req: {
  abortController: AbortController
  header: {
    apiKey: string
    baseURL: string
    mcpServerURLs: string
  }
  model: string
  messages: Message[]
  stream: boolean
  temperature?: number
  maxTokens?: number
  onStream?: (stream: { content: string; reasoning_content: string }) => void
}): Promise<{
  model: string
  finish_reason: string
  message: {
    content: string
    reasoning_content: string
  }
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    reasoningTokens?: number
  } | null
} | null> => {
  const result = {
    content: '',
    reasoning_content: '',
  }
  let finish_reason = ''
  let usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  } | null = null
  let responseModel = 'N/A'

  // Call the Chat API
  // TODO: [!] Cognitive Complexity
  try {
    const res = await client.api.chat.$post(
      {
        header: {
          'api-key': req.header.apiKey,
          'base-url': req.header.baseURL,
          'mcp-server-urls': req.header.mcpServerURLs,
        },
        json: {
          messages: req.messages,
          model: req.model,
          stream: req.stream,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          stream_options: req.stream
            ? {
                include_usage: true,
              }
            : undefined,
        },
      },
      { init: { signal: req.abortController.signal } }
    )
    if (!res.ok) {
      const error = (await res.json()) as unknown as { message?: string }
      result.content = error?.message || JSON.stringify(error)
    } else {
      const nonStream = res.headers.get('Content-Type') === 'application/json'
      if (nonStream) {
        const data = (await res.json()) as unknown as {
          choices: {
            message: { content: string; reasoning_content?: string }
          }[]
          model?: string
          usage?: {
            prompt_tokens: number
            completion_tokens: number
            total_tokens: number
            reasoning_tokens: number
          }
        }
        result.reasoning_content = data.choices[0].message?.reasoning_content || ''
        result.content = data.choices[0].message.content
        responseModel = data?.model || 'N/A'
        usage = data?.usage ?? null
      } else {
        const reader = res.body?.getReader()
        if (!reader) {
          throw new Error('Failed to get reader from response body.')
        }
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        let running = true
        while (running) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          while (running) {
            const idx = buffer.indexOf('\n')
            if (idx === -1) break

            const line = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 1)
            if (!line.startsWith('data: ')) continue

            const jsonStr = line.replace(/^data:\s*/, '')
            if (jsonStr === '[DONE]') {
              console.log('Stream completed.')
              running = false
              break
            }
            try {
              const parsedChunk = JSON.parse(jsonStr) as {
                choices: {
                  delta: { content: string; reasoning_content?: string }
                  finish_reason: string
                }[]
                model?: string
                usage?: {
                  prompt_tokens: number
                  completion_tokens: number
                  total_tokens: number
                  completion_tokens_details?: {
                    reasoning_tokens?: number
                  }
                }
              }
              // Append chunk to result
              result.reasoning_content += parsedChunk.choices.at(0)?.delta?.reasoning_content || ''
              result.content += parsedChunk.choices.at(0)?.delta?.content || ''
              const _finish_reason = parsedChunk.choices.at(0)?.finish_reason || ''
              if (_finish_reason) {
                finish_reason = _finish_reason
              }
              if (parsedChunk?.model) {
                responseModel = parsedChunk.model
              }
              if (parsedChunk?.usage) {
                usage = parsedChunk.usage
              }
              const streamChunk = {
                content: result.content ? `${result.content}` : '',
                reasoning_content: result.reasoning_content,
              }
              req.onStream?.(streamChunk)
            } catch (e) {
              console.error('JSON parse error:', e)
              running = false
              break
            }
          }
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
  if (!result.content) {
    return null
  }
  return {
    model: responseModel,
    finish_reason,
    message: result,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
        }
      : null,
  }
}
