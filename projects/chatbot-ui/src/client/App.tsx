import { useEffect, useRef, useState } from 'react'
import { Header } from '#/components/Header'
import { type Message, MessageArea } from '#/components/MessageArea'
import { MessageAreaScroll } from '#/components/MessageAreaScroll'
import { MessageInput } from '#/components/MessageInput'

export function App() {
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // メッセージの状態管理
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      content: 'こんにちは！\n何かお手伝いできることはありますか？',
      sender: 'bot',
      timestamp: new Date(),
    },
  ])
  const [streamingText, setStreamingText] = useState('')

  // メッセージ送信処理
  const handleSendMessage = async (message: string) => {
    setLoading(true)

    // ユーザーメッセージを追加
    const userMessage: Message = {
      id: Date.now().toString(),
      content: message,
      sender: 'user',
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    })

    if (!response.ok) {
      alert(`Error fetching chat response: ${response.statusText}`)
      setLoading(false)
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Failed to get reader from response body.')
    }

    let chunks = ''

    const decoder = new TextDecoder('utf-8')
    let done = false

    while (!done) {
      const { done: isDone, value } = await reader.read()
      done = isDone

      if (value) {
        chunks += decoder.decode(value, { stream: true })
        setStreamingText(`${chunks}`)
      }
    }

    setStreamingText('')
    setLoading(false)
    setMessages((prev) => [
      ...prev,
      {
        id: (Date.now() + 1).toString(),
        content: chunks,
        sender: 'bot',
        timestamp: new Date(),
      },
    ])
  }

  const handleSendMessageCancel = () => {
    // TODO
  }

  useEffect(() => {
    // メッセージが更新されたときにスクロール
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  return (
    <div className='flex h-dvh flex-col bg-background'>
      {/* ヘッダー */}
      <Header />

      {/* メッセージエリア */}
      <MessageAreaScroll ref={messagesEndRef}>
        <MessageArea messages={messages} streamingText={streamingText} loading={loading} />
      </MessageAreaScroll>

      {/* 入力エリア */}
      <MessageInput
        loading={loading}
        onSendMessage={handleSendMessage}
        onSendMessageCancel={handleSendMessageCancel}
      />
    </div>
  )
}
