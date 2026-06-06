import {
  ChatTextInput,
  Header,
  MarkdownRenderer,
  MessageArea,
  MessageAreaScroll,
  initializeTheme,
} from '#/chatbot-ui'
import { useChat } from './useChat'

// テーマを初期化
initializeTheme()

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
