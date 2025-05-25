import { Header } from '#/components/Header'
import { MessageArea } from '#/components/MessageArea'
import { MessageAreaScroll } from '#/components/MessageAreaScroll'
import { MessageInput } from '#/components/MessageInput'
import { useChat } from './useChat'

export function App() {
  const chat = useChat()
  return (
    <div className='flex h-dvh flex-col bg-background'>
      {/* ヘッダー */}
      <Header />

      {/* メッセージエリア */}
      <MessageAreaScroll ref={chat.messagesEndRef}>
        <MessageArea
          messages={chat.messages}
          streamingText={chat.streaming.text}
          loading={chat.streaming.state === 'streaming'}
        />
      </MessageAreaScroll>

      {/* 入力エリア */}
      <MessageInput
        loading={chat.streaming.state === 'streaming'}
        onSendMessage={chat.handleSendMessage}
        onSendMessageCancel={chat.handleSendMessageCancel}
      />
    </div>
  )
}
