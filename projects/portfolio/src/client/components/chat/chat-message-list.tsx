import { ChatResults } from '#/client/components/chat/chat-results'
import { CodeBlockRenderer, MarkdownLink } from '#/client/components/chat/code-block-renderer'
import { MessageRenderer } from '#/client/components/chat/message-renderer'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { SpinnerIcon } from '#/client/components/svg/spinner-icon'
import type { ChatResultSummary, ChatStreamState, Message } from '#/types'
import { memo, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const markdownRemarkPlugins = [remarkGfm]
const markdownComponents = {
  a: MarkdownLink,
  code: CodeBlockRenderer,
}

interface ChatMessageListProps {
  messages: Message[]
  markdownPreview: boolean
  loading: boolean
  stream: ChatStreamState | null
  chatResults: ChatResultSummary | null
  copiedId: string
  messageEndRef: RefObject<HTMLDivElement | null>
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage: (index: number) => void
}

export function ChatMessageList({
  messages,
  markdownPreview,
  loading,
  stream,
  chatResults,
  copiedId,
  messageEndRef,
  onCopyMessage,
  onDeleteMessage,
}: ChatMessageListProps) {
  return (
    <div className='container mx-auto mt-4 max-w-(--breakpoint-lg) px-4'>
      <div className='message-list'>
        <MessageHistory
          messages={messages}
          markdownPreview={markdownPreview}
          copiedId={copiedId}
          disabled={loading || !!stream}
          onCopyMessage={onCopyMessage}
          onDeleteMessage={onDeleteMessage}
        />
        {loading && (
          <div className='flex align-item'>
            <div className='flex h-8 w-8 justify-center rounded-full border border-gray-300 bg-white align-center dark:border-gray-600 dark:bg-gray-900'>
              <ChatbotIcon size={32} className='stroke-gray-600 dark:stroke-gray-300' />
            </div>
            {stream ? (
              <div className='message ml-2 text-left'>
                {stream.reasoning_content && (
                  <div className='wrap-break-word whitespace-pre-line break-all text-gray-400 text-xs dark:text-gray-200'>
                    {stream.reasoning_content}
                  </div>
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
        {!loading && chatResults && (
          <ChatResults
            model={chatResults.model}
            finishReason={chatResults.finish_reason}
            responseTimeMs={chatResults.responseTimeMs}
            usage={chatResults.usage}
          />
        )}
        <div ref={messageEndRef} className='h-4' />
      </div>
    </div>
  )
}

interface MessageHistoryProps {
  messages: Message[]
  markdownPreview: boolean
  copiedId: string
  disabled: boolean
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage: (index: number) => void
}

const MessageHistory = memo(function MessageHistory({
  messages,
  markdownPreview,
  copiedId,
  disabled,
  onCopyMessage,
  onDeleteMessage,
}: MessageHistoryProps) {
  return messages.map((message, index) => (
    <MessageRenderer
      key={`chat_${index}`}
      message={message}
      index={index}
      markdownPreview={markdownPreview}
      copied={copiedId === `chat_${index}`}
      disabled={disabled}
      onCopyMessage={onCopyMessage}
      onDeleteMessage={onDeleteMessage}
    />
  ))
})
