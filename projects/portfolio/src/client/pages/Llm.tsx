import { hc } from 'hono/client'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AppType } from '#/server/app.d'

const client = hc<AppType>('/')

// API設定の定数
const API_CONFIG = {
  model: 'gpt-4.1-nano',
  baseURL: 'https://api.openai.com/v1',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY || 'your-api-key',
  temperature: 0.7,
  maxTokens: 2000,
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
}

function ChatInput({ value, onChange, onSubmit, disabled }: ChatInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className='border-gray-200 border-t bg-white p-4 dark:border-gray-700 dark:bg-gray-800'>
      <div className='mx-auto flex max-w-4xl items-end gap-3'>
        <div className='flex-1'>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='メッセージを入力してください...'
            disabled={disabled}
            rows={1}
            className='w-full resize-none rounded-lg border border-gray-300 bg-white p-3 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400'
            style={{ minHeight: '44px', maxHeight: '120px' }}
          />
        </div>
        <button
          type='button'
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
          className='rounded-lg bg-blue-600 p-3 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400 dark:bg-blue-500 dark:disabled:bg-gray-600 dark:hover:bg-blue-600'
        >
          <svg
            width='20'
            height='20'
            viewBox='0 0 24 24'
            fill='none'
            xmlns='http://www.w3.org/2000/svg'
            aria-label='送信'
          >
            <title>送信</title>
            <path
              d='M22 2L11 13'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            />
            <path
              d='M22 2L15 22L11 13L2 9L22 2Z'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            />
          </svg>
        </button>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: Message
  isLoading?: boolean
}

function MessageBubble({ message, isLoading }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`flex max-w-[70%] ${isUser ? 'flex-row-reverse' : 'flex-row'} items-start gap-3`}
      >
        {/* アバター */}
        <div
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
            isUser
              ? 'bg-blue-600 text-white dark:bg-blue-500'
              : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
          }`}
        >
          {isUser ? (
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='currentColor'
              aria-label='ユーザー'
            >
              <title>ユーザー</title>
              <path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z' />
            </svg>
          ) : (
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='currentColor'
              aria-label='アシスタント'
            >
              <title>アシスタント</title>
              <path d='M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4C22,2.89 21.1,2 20,2Z' />
            </svg>
          )}
        </div>

        {/* メッセージ内容 */}
        <div
          className={`rounded-lg px-4 py-2 ${
            isUser
              ? 'bg-blue-600 text-white dark:bg-blue-500'
              : 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
          }`}
        >
          {isUser ? (
            <p className='whitespace-pre-wrap break-words'>{message.content}</p>
          ) : (
            <div className='prose prose-sm dark:prose-invert max-w-none'>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
          {isLoading && !isUser && (
            <div className='mt-2 flex items-center gap-1'>
              <div className='h-2 w-2 animate-pulse rounded-full bg-gray-400' />
              <div
                className='h-2 w-2 animate-pulse rounded-full bg-gray-400'
                style={{ animationDelay: '0.2s' }}
              />
              <div
                className='h-2 w-2 animate-pulse rounded-full bg-gray-400'
                style={{ animationDelay: '0.4s' }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function Llm(): ReactElement {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null)
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return false
  })
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingMessage])

  const toggleDarkMode = () => {
    setIsDark((prev) => {
      const next = !prev
      if (next) {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
      return next
    })
  }

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setIsLoading(true)

    try {
      // APIリクエストの準備
      const requestMessages = [
        ...messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        {
          role: 'user' as const,
          content: userMessage.content,
        },
      ]

      // ストリーミング用のアシスタントメッセージを準備
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '',
        timestamp: new Date(),
      }
      setStreamingMessage(assistantMessage)

      // APIコール
      const res = await client.api.chat.$post({
        header: {
          'api-key': API_CONFIG.apiKey,
          'base-url': API_CONFIG.baseURL,
          'mcp-server-urls': '',
        },
        json: {
          messages: requestMessages,
          model: API_CONFIG.model,
          stream: true,
          temperature: API_CONFIG.temperature,
          max_tokens: API_CONFIG.maxTokens,
          stream_options: {
            include_usage: true,
          },
        },
      })

      if (!res.ok) {
        throw new Error('API request failed')
      }

      // ストリーミングレスポンスの処理
      const reader = res.body?.getReader()
      if (!reader) {
        throw new Error('Failed to get reader from response body')
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let running = true
      let fullContent = ''

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
            running = false
            break
          }

          try {
            const parsedChunk = JSON.parse(jsonStr) as {
              choices: {
                delta: { content?: string }
                finish_reason?: string
              }[]
            }

            const deltaContent = parsedChunk.choices?.[0]?.delta?.content || ''
            if (deltaContent) {
              fullContent += deltaContent
              setStreamingMessage((prev) =>
                prev
                  ? {
                      ...prev,
                      content: fullContent,
                    }
                  : null,
              )
            }

            if (parsedChunk.choices?.[0]?.finish_reason) {
              running = false
            }
          } catch (e) {
            console.error('JSON parse error:', e)
            running = false
          }
        }
      }

      // ストリーミング完了後、最終メッセージを追加
      const finalAssistantMessage: Message = {
        ...assistantMessage,
        content: fullContent,
      }

      setMessages((prev) => [...prev, finalAssistantMessage])
      setStreamingMessage(null)
    } catch (error) {
      console.error('Error sending message:', error)

      // エラーメッセージを表示
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'エラーが発生しました。もう一度お試しください。',
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, errorMessage])
      setStreamingMessage(null)
    } finally {
      setIsLoading(false)
    }
  }

  const clearChat = () => {
    setMessages([])
    setStreamingMessage(null)
    setInput('')
  }

  return (
    <div className='flex h-screen flex-col bg-white dark:bg-gray-900'>
      {/* ヘッダー */}
      <div className='border-gray-200 border-b bg-white p-4 dark:border-gray-700 dark:bg-gray-800'>
        <div className='mx-auto flex max-w-4xl items-center justify-between'>
          <h1 className='font-bold text-gray-900 text-xl dark:text-white'>LLM Chat</h1>
          <div className='flex gap-2'>
            <button
              type='button'
              onClick={toggleDarkMode}
              aria-label={isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
              className='flex items-center rounded-lg bg-gray-100 px-3 py-1 text-gray-700 text-sm transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            >
              {isDark ? (
                <span role='img' aria-label='ライトモード'>
                  ☀️
                </span>
              ) : (
                <span role='img' aria-label='ダークモード'>
                  🌙
                </span>
              )}
            </button>
            <button
              type='button'
              onClick={clearChat}
              className='rounded-lg bg-gray-100 px-3 py-1 text-gray-700 text-sm transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            >
              チャットをクリア
            </button>
          </div>
        </div>
      </div>

      {/* メッセージエリア */}
      <div className='flex-1 overflow-y-auto'>
        <div className='mx-auto max-w-4xl'>
          {messages.length === 0 && !streamingMessage && (
            <div className='flex h-full items-center justify-center'>
              <div className='text-center'>
                <div className='mb-4 font-bold text-2xl text-gray-900 dark:text-white'>
                  AIアシスタントにお気軽にお聞きください
                </div>
                <p className='text-gray-600 dark:text-gray-400'>
                  何でもお聞きください。お手伝いいたします。
                </p>
              </div>
            </div>
          )}

          {messages.map((message, idx) => (
            <div key={message.id} className={idx === 0 ? 'mt-4' : ''}>
              <MessageBubble message={message} />
            </div>
          ))}

          {streamingMessage && <MessageBubble message={streamingMessage} isLoading={isLoading} />}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 入力エリア */}
      <ChatInput value={input} onChange={setInput} onSubmit={sendMessage} disabled={isLoading} />
    </div>
  )
}
