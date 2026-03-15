import { ChatInput } from '#/client/components/chat/chat-input'
import { ChatMessageList } from '#/client/components/chat/chat-message-list'
import { PromptTemplate, type TemplateInput } from '#/client/components/chat/prompt-template'
import { FileImageInput, FileImagePreview } from '#/client/components/input/file-image-input'
import { ArrowUpIcon } from '#/client/components/svg/arrow-upIcon'
import { StopIcon } from '#/client/components/svg/stop-icon'
import { UploadIcon } from '#/client/components/svg/upload-icon'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { AppType } from '#/server/app.d'
import type { ChatMessage, ChatMessageSystem, ChatMessageUser, ChatCompletionResult, Conversation } from '#/types'
import { hc } from 'hono/client'
import React, {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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

const MIN_TEXT_LINE_COUNT = 2
const MAX_TEXT_LINE_COUNT = 5

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
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [copiedId, setCopiedId] = useState('')
  const [stream, setStream] = useState<{
    content: string
    reasoning_content?: string
  } | null>(null)
  const [chatResults, setChatResults] = useState<{
    model?: string
    finish_reason: string
    responseTimeMs?: number
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
    const convertedMessages: ChatMessage[] = currentConversation.messages.map((msg) => {
      const base = {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      }
      if (msg.role === 'assistant') {
        return {
          ...base,
          reasoning_content: msg.reasoningContent,
        } as ChatMessage
      }
      return base as ChatMessage
    })
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
    const requestStartTime = Date.now()
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
      reasoningEffort: settings.reasoningEffortEnabled ? settings.reasoningEffort : undefined,
      onStream: (stream) => {
        setStream(stream)
      },
    }).then((result) => {
      const responseTimeMs = Date.now() - requestStartTime
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
                reasoningContent: result.message.reasoningContent,
                metadata: {
                  model: result.model,
                  finishReason: result.finishReason,
                  responseTimeMs: responseTimeMs,
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
            content: result.message.content,
            reasoning_content: result.message.reasoningContent,
          },
        ]
        setMessages(newMessages)
        setChatResults({
          model: result.model,
          finish_reason: result.finishReason,
          responseTimeMs: responseTimeMs,
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

  const handleClickCopyMessage = async (message: string, index: number) => {
    setCopiedId(`chat_${index}`)
    try {
      await copyToClipboard(message)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } catch (error) {
      alert(error)
    }
    setCopiedId('')
  }

  const handleClickDeleteMessage = (index: number) => {
    if (confirm('本当に削除しますか？')) {
      let isConversationEmpty = false
      setMessages((prevMessages) => {
        const newMessages = [...prevMessages]
        newMessages.splice(index, 1)
        newMessages.splice(index, 1)
        isConversationEmpty = newMessages.length <= 0
        return newMessages
      })
      const deleteMessageIds = [
        currentConversation?.messages?.at(index)?.id,
        currentConversation?.messages?.at(index + 1)?.id,
      ].filter((value): value is string => value !== undefined)
      onDeleteMessages?.(deleteMessageIds, isConversationEmpty)
    }
  }

  const emptyMessage = messages.length === 0

  return (
    <form ref={formRef} onSubmit={handleSubmit} className='h-full'>
      {emptyMessage && (
        <div className='flex h-full items-center justify-center'>
          <div className='container mx-auto flex max-w-(--breakpoint-lg) flex-1 items-center justify-center'>
            <div className='flex w-full flex-col justify-center gap-3'>
              <div
                className={
                  'mb-2 text-center font-bold text-2xl text-gray-700 hidden md:block sm:text-3xl dark:text-gray-200'
                }
              >
                お手伝いできることはありますか？
              </div>
              <div className='hidden md:block'>
                <PromptTemplate
                  placeholder={settings.model}
                  onSubmit={(templateInput) => {
                    setTemplateInput(templateInput)
                    formRef?.current?.requestSubmit()
                  }}
                />
              </div>
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
          <ChatMessageList
            messages={messages}
            settings={settings}
            loading={loading}
            stream={stream}
            chatResults={chatResults}
            copiedId={copiedId}
            messageEndRef={messageEndRef}
            onCopyMessage={handleClickCopyMessage}
            onDeleteMessage={handleClickDeleteMessage}
          />
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
  {
    interactiveMode,
    messages,
    uploadImages,
  }: { interactiveMode: boolean; messages: ChatMessage[]; uploadImages: string[] }
): {
  model: string
  messages: ChatMessage[]
} | null => {
  if (!inputText) {
    return null
  }
  const userMessage: ChatMessageUser = {
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
  const newMessages: ChatMessage[] = [...messages, userMessage]
  return {
    model,
    messages: interactiveMode ? newMessages : [userMessage],
  }
}

const createTemplateMessage = (
  templateInput: TemplateInput,
  model: string,
  { interactiveMode, messages }: { interactiveMode: boolean; messages: ChatMessage[] }
): {
  model: string
  messages: ChatMessage[]
} => {
  const userMessage: ChatMessageUser = {
    role: 'user',
    content: templateInput.content,
  }
  const systemMessage: ChatMessageSystem = {
    role: 'system',
    content: templateInput.prompt,
  }
  const newMessages: ChatMessage[] =
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
  messages: ChatMessage[]
  stream: boolean
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  onStream?: (stream: { content: string; reasoning_content: string }) => void
}): Promise<ChatCompletionResult | null> => {
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
          reasoning_effort: req.reasoningEffort,
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
    finishReason: finish_reason,
    message: {
      content: result.content,
      reasoningContent: result.reasoning_content,
    },
    responseTimeMs: 0,
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
