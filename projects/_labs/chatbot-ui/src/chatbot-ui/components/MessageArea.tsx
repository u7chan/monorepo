import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Card, CardContent } from './ui/card'

// メッセージの型定義
export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface MessageAreaProps {
  messages: Message[]
  streamingText?: string
  loading?: boolean
  userIcon?: string | ReactNode
  botIcon?: string | ReactNode
  renderer?: (content: string) => ReactNode
}

const defaultRenderer = (content: string) => <p className='whitespace-pre-wrap'>{content}</p>

export function MessageArea({
  messages,
  streamingText,
  loading,
  userIcon,
  botIcon,
  renderer = defaultRenderer,
}: MessageAreaProps) {
  return (
    <div className='container mx-auto max-w-4xl space-y-4'>
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`flex max-w-[80%] gap-3 ${
              message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
            }`}
          >
            {/* ユーザーアバター */}
            {message.role === 'user' && (
              <>
                {userIcon && typeof userIcon === 'string' ? (
                  <Avatar className='bg-secondary'>
                    <AvatarImage src={userIcon} />
                    <AvatarFallback>U</AvatarFallback>
                  </Avatar>
                ) : (
                  userIcon
                )}
              </>
            )}

            {/* Botアバター */}
            {message.role === 'assistant' && (
              <>
                {botIcon && typeof botIcon === 'string' ? (
                  <Avatar className='bg-primary'>
                    <AvatarImage src={botIcon} />
                    <AvatarFallback>B</AvatarFallback>
                  </Avatar>
                ) : (
                  botIcon
                )}
              </>
            )}

            {/* メッセージカード */}
            <Card
              className={`${message.role === 'user' ? 'border-none bg-slate-200 dark:bg-slate-700' : 'bg-card'}`}
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
        <div className='flex max-w-[80%] gap-3'>
          {/* Botアバター */}
          {botIcon && typeof botIcon === 'string' ? (
            <Avatar className='bg-primary'>
              <AvatarImage src={botIcon} />
              <AvatarFallback>B</AvatarFallback>
            </Avatar>
          ) : (
            botIcon
          )}
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
