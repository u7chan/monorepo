import type { SaveGeneratedFileRequest } from '#/client/components/chat/assistant-code-block'
import { CodeBlockRenderer, MarkdownLink } from '#/client/components/chat/code-block-renderer'
import type { ChatStreamState } from '#/client/components/chat/hooks/chat-response'
import { MessageRenderer } from '#/client/components/chat/message-renderer'
import { ReasoningSection } from '#/client/components/chat/reasoning-section'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { SpinnerIcon } from '#/client/components/svg/spinner-icon'
import type { GeneratedCodeFile, Message } from '#/types'
import { memo, type ReactNode, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const markdownRemarkPlugins = [remarkGfm]
const markdownComponents = {
  a: MarkdownLink,
  code: CodeBlockRenderer,
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
}

interface ChatMessageListProps {
  messages: Message[]
  conversationId: string | null
  canSaveGeneratedFile?: boolean
  markdownPreview: boolean
  loading: boolean
  stream: ChatStreamState | null
  copiedId: string
  savingConversation?: boolean
  messageEndRef: RefObject<HTMLDivElement | null>
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage: (index: number) => void
  onSaveGeneratedFile?: (messageIndex: number, params: SaveGeneratedFileRequest) => Promise<GeneratedCodeFile | null>
}

export function ChatMessageList({
  messages,
  conversationId,
  canSaveGeneratedFile,
  markdownPreview,
  loading,
  stream,
  copiedId,
  savingConversation,
  messageEndRef,
  onCopyMessage,
  onDeleteMessage,
  onSaveGeneratedFile,
}: ChatMessageListProps) {
  return (
    <div className='container mx-auto mt-4 max-w-(--breakpoint-lg) px-4'>
      <div className='message-list'>
        <MessageHistory
          messages={messages}
          conversationId={conversationId}
          canSaveGeneratedFile={canSaveGeneratedFile}
          markdownPreview={markdownPreview}
          copiedId={copiedId}
          disabled={loading || !!stream}
          savingConversation={savingConversation}
          onCopyMessage={onCopyMessage}
          onDeleteMessage={onDeleteMessage}
          onSaveGeneratedFile={onSaveGeneratedFile}
        />
        {loading && (
          <div className='flex align-item'>
            <div className='flex h-8 w-8 justify-center rounded-full border border-gray-300 bg-white align-center dark:border-gray-600 dark:bg-gray-800'>
              <ChatbotIcon size={32} className='stroke-gray-600 dark:stroke-white' />
            </div>
            {stream ? (
              <div className='message ml-2 min-w-0 flex-1 text-left'>
                {stream.reasoningContent && (
                  <ReasoningSection content={stream.reasoningContent} isStreaming={!stream.content} />
                )}
                {markdownPreview ? (
                  <div className='prose mt-1 max-w-(--breakpoint-md) break-all dark:text-white'>
                    <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={markdownComponents}>
                      {stream.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className='message text-left'>
                    <p className='wrap-break-word mt-1 inline-block whitespace-pre-wrap break-all'>{stream.content}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className='ml-2 scale-75'>
                <SpinnerIcon />
              </div>
            )}
          </div>
        )}
        <div ref={messageEndRef} className='h-4' />
      </div>
    </div>
  )
}

interface MessageHistoryProps {
  messages: Message[]
  conversationId: string | null
  canSaveGeneratedFile?: boolean
  markdownPreview: boolean
  copiedId: string
  disabled: boolean
  savingConversation?: boolean
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage: (index: number) => void
  onSaveGeneratedFile?: (messageIndex: number, params: SaveGeneratedFileRequest) => Promise<GeneratedCodeFile | null>
}

const MessageHistory = memo(function MessageHistory({
  messages,
  conversationId,
  canSaveGeneratedFile,
  markdownPreview,
  copiedId,
  disabled,
  savingConversation,
  onCopyMessage,
  onDeleteMessage,
  onSaveGeneratedFile,
}: MessageHistoryProps) {
  return messages.map((message, index) => (
    <MessageRenderer
      key={message.id ?? `chat_${index}`}
      message={message}
      index={index}
      conversationId={conversationId}
      canSaveGeneratedFile={canSaveGeneratedFile}
      markdownPreview={markdownPreview}
      copied={copiedId === `chat_${index}`}
      disabled={disabled}
      savingConversation={savingConversation}
      onCopyMessage={onCopyMessage}
      onDeleteMessage={onDeleteMessage}
      onSaveGeneratedFile={onSaveGeneratedFile}
    />
  ))
})
