import { ChatTextInput } from '#/components/ChatTextInput'
import { Header } from '#/components/Header'
import { MarkdownRenderer } from '#/components/MarkdownRenderer'
import { MessageArea } from '#/components/MessageArea'
import { MessageAreaScroll } from '#/components/MessageAreaScroll'
import { useChat } from '#/hooks/useChat'

export function App() {
  const chat = useChat()
  return (
    <div className='flex h-dvh flex-col bg-background'>
      {/* ヘッダー */}
      <Header />

      {/* メッセージエリア */}
      <MessageAreaScroll
        ref={chat.messagesEndRef}
        scrollContainerRef={chat.scrollContainerRef}
        onScroll={chat.handleScroll}
      >
        <MessageArea
          messages={chat.messages}
          streamingText={chat.streaming.text}
          loading={chat.streaming.state === 'streaming'}
          userIcon='https://avatars.githubusercontent.com/u/34462401'
          botIcon='https://github.com/shadcn.png'
          renderer={(content) => <MarkdownRenderer content={content} />}
        />
      </MessageAreaScroll>

      {/* 入力エリア */}
      <ChatTextInput
        loading={chat.streaming.state === 'streaming'}
        onSendMessage={chat.handleSendMessage}
        onSendMessageCancel={chat.handleSendMessageCancel}
      />
    </div>
  )
}
