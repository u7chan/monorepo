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

    let content = ''
    const useMock = true
    if (useMock) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      content = 'ご質問ありがとうございます。どのようにお手伝いできますか？'
    } else {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
      })
      content = response.ok ? await response.text() : 'エラーが発生しました。'
    }
    setMessages((prev) => [
      ...prev,
      {
        id: (Date.now() + 1).toString(),
        content,
        sender: 'bot',
        timestamp: new Date(),
      },
    ])
    setLoading(false)
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
        <MessageArea messages={messages} loading={loading} />
      </MessageAreaScroll>

      {/* 入力エリア */}
      <MessageInput onSendMessage={handleSendMessage} disabled={loading} />
    </div>
  )
}
