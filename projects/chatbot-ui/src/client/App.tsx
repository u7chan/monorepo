import { useState } from 'react'
import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
import { Card, CardContent } from '#/components/ui/card'
import { Input } from '#/components/ui/input'

// メッセージの型定義
type Message = {
  id: string
  content: string
  sender: 'user' | 'bot'
  timestamp: Date
}

export function App() {
  // メッセージの状態管理
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      content: 'こんにちは！何かお手伝いできることはありますか？',
      sender: 'bot',
      timestamp: new Date(),
    },
  ])

  // 入力メッセージの状態管理
  const [inputMessage, setInputMessage] = useState('')

  // メッセージ送信処理
  const handleSendMessage = () => {
    if (!inputMessage.trim()) return

    // ユーザーメッセージを追加
    const userMessage: Message = {
      id: Date.now().toString(),
      content: inputMessage,
      sender: 'user',
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInputMessage('')

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

  return (
    <div className='flex flex-col h-screen bg-background'>
      {/* ヘッダー */}
      <header className='border-b p-3 bg-card'>
        <div className='container mx-auto flex items-center'>
          <h1 className='text-xl font-bold'>Chatbot UI</h1>
        </div>
      </header>

      {/* メッセージエリア */}
      <div className='flex-1 overflow-y-auto p-4'>
        <div className='container mx-auto max-w-4xl space-y-4'>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`flex gap-3 max-w-[80%] ${message.sender === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {/* アバター */}
                <Avatar className={message.sender === 'bot' ? 'bg-primary' : 'bg-secondary'}>
                  <AvatarFallback>{message.sender === 'user' ? 'U' : 'B'}</AvatarFallback>
                </Avatar>

                {/* メッセージカード */}
                <Card
                  className={`${message.sender === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card'}`}
                >
                  <CardContent className='p-3'>
                    <p>{message.content}</p>
                    <div className='text-xs opacity-70 mt-1 text-right'>
                      {message.timestamp.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 入力エリア */}
      <div className='border-t p-4 bg-card'>
        <div className='container mx-auto max-w-4xl'>
          <form
            className='flex gap-2'
            onSubmit={(e) => {
              e.preventDefault()
              handleSendMessage()
            }}
          >
            <Input
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder='メッセージを入力...'
              className='flex-1'
            />
            <Button type='submit' disabled={!inputMessage.trim()}>
              送信
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
