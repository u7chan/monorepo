import { useEffect, useRef, useState } from 'react'
import { Header } from '#/components/Header'
import { type Message, MessageArea } from '#/components/MessageArea'
import { MessageAreaScroll } from '#/components/MessageAreaScroll'
import { MessageInput } from '#/components/MessageInput'

export function App() {
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
  const handleSendMessage = (message: string) => {
    // ユーザーメッセージを追加
    const userMessage: Message = {
      id: Date.now().toString(),
      content: message,
      sender: 'user',
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])

    // ボットの応答を追加（実際のアプリではAPIリクエストなどが入る）
    setTimeout(() => {
      const botMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: 'ご質問ありがとうございます。どのようにお手伝いできますか？',
        sender: 'bot',
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, botMessage])
    }, 1000)
  }

  useEffect(() => {
    // メッセージが更新されたときにスクロール
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])
  return (
    <div className='flex h-screen flex-col bg-background'>
      {/* ヘッダー */}
      <Header />

      {/* メッセージエリア */}
      <MessageAreaScroll ref={messagesEndRef}>
        <MessageArea messages={messages} />
      </MessageAreaScroll>

      {/* 入力エリア */}
      <MessageInput onSendMessage={handleSendMessage} />
    </div>
  )
}
