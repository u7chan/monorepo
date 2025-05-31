import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '#/components/ui/avatar'
import { Card, CardContent } from '#/components/ui/card'

// メッセージの型定義
export type Message = {
  id: string
  content: string
  sender: 'user' | 'bot'
  timestamp: Date
}

interface MessageAreaProps {
  messages: Message[]
  streamingText?: string
  loading?: boolean
  renderer?: (content: string) => ReactNode
}

const defaultRenderer = (content: string) => <p className='whitespace-pre-wrap'>{content}</p>

export function MessageArea({
  messages,
  streamingText,
  loading,
  renderer = defaultRenderer,
}: MessageAreaProps) {
  return (
    <div className='container mx-auto max-w-4xl space-y-4'>
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`flex max-w-[80%] gap-3 ${
              message.sender === 'user' ? 'flex-row-reverse' : 'flex-row'
            }`}
          >
            {/* アバター */}
            <Avatar className={message.sender === 'bot' ? 'bg-primary' : 'bg-secondary'}>
              <AvatarImage
                src={
                  message.sender === 'user'
                    ? 'https://avatars.githubusercontent.com/u/34462401'
                    : 'https://github.com/shadcn.png'
                }
              />
              <AvatarFallback>{message.sender === 'user' ? 'U' : 'B'}</AvatarFallback>
            </Avatar>

            {/* メッセージカード */}
            <Card
              className={`${message.sender === 'user' ? 'border-none bg-slate-200 dark:bg-slate-700' : 'bg-card'}`}
            >
              <CardContent className='p-3'>
                {renderer(message.content)}
                <div className='mt-1 text-right text-xs opacity-70'>
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
      {loading && (
        <div className='flex gap-3'>
          {/* アバター */}
          <Avatar className='bg-primary'>
            <AvatarImage src='https://github.com/shadcn.png' />
          </Avatar>
          <Card className='bg-card'>
            <CardContent className='p-3'>
              {streamingText ? (
                renderer(streamingText)
              ) : (
                <>
                  <Loader2 className='h-5 w-5 animate-spin text-gray-500' />
                  <span className='text-muted-foreground text-xs'>応答を生成中...</span>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
