import {
  AssistantAwareCodeBlock,
  AssistantCodeBlockContext,
  type SaveGeneratedFileRequest,
} from '#/client/components/chat/assistant-code-block'
import { ChatResults } from '#/client/components/chat/chat-results'
import { MarkdownLink } from '#/client/components/chat/code-block-renderer'
import { ReasoningSection } from '#/client/components/chat/reasoning-section'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { DeleteIcon } from '#/client/components/svg/delete-icon'
import type { GeneratedCodeFile, Message } from '#/types'
import { isImageContentArray } from '#/types'
import { Fragment, memo, type ReactNode, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough'
import remarkGfm from 'remark-gfm'

const markdownRemarkPlugins = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough]
const markdownComponents = {
  a: MarkdownLink,
  code: AssistantAwareCodeBlock,
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
}

interface MessageRendererProps {
  message: Message
  index: number
  conversationId: string | null
  canSaveGeneratedFile?: boolean
  markdownPreview: boolean
  copied: boolean
  disabled?: boolean
  savingConversation?: boolean
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage?: (index: number) => void
  onSaveGeneratedFile?: (messageIndex: number, params: SaveGeneratedFileRequest) => Promise<GeneratedCodeFile | null>
}

interface MessageActionBarProps {
  copied: boolean
  disabled?: boolean
  children: ReactNode
  align?: 'left' | 'right'
}

interface CopyMessageButtonProps {
  copied: boolean
  onClick: () => void
}

function MessageActionBar({ copied, disabled, children, align = 'left' }: MessageActionBarProps) {
  return (
    <div
      className={`mt-1 ml-1 flex items-center gap-1 transition-opacity duration-200 ease-out motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 ${
        copied ? 'opacity-100' : ''
      } ${align === 'right' ? 'justify-end' : ''} ${disabled ? 'invisible' : ''}`}
    >
      {children}
    </div>
  )
}

function CopyMessageButton({ copied, onClick }: CopyMessageButtonProps) {
  return (
    <button
      type='button'
      className={`relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-[background-color,color,transform] duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:focus-visible:ring-gray-500 disabled:cursor-default ${
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-white'
      }`}
      onClick={onClick}
      disabled={copied}
      aria-label={copied ? 'Copied' : 'Copy message'}
    >
      <span
        aria-hidden='true'
        className={`absolute transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
          copied ? '-translate-y-0.5 scale-90 opacity-0' : 'translate-y-0 scale-100 opacity-100'
        }`}
      >
        <CopyIcon size={20} className='stroke-current' />
      </span>
      <span
        aria-hidden='true'
        className={`absolute transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
          copied ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-0.5 scale-90 opacity-0'
        }`}
      >
        <CheckIcon size={20} className='stroke-current' />
      </span>
    </button>
  )
}

function MessageRendererComponent({
  message,
  index,
  conversationId,
  canSaveGeneratedFile,
  markdownPreview,
  copied,
  disabled,
  savingConversation,
  onCopyMessage,
  onDeleteMessage,
  onSaveGeneratedFile,
}: MessageRendererProps) {
  // fenced code block 用の cursor。render のたびに 0 にリセットし、
  // 子の AssistantAwareCodeBlock が順序どおり blockIndex を取得できるようにする。
  const cursorRef = useRef({ current: 0 })
  cursorRef.current.current = 0

  if (message.role === 'system') {
    return null
  }

  if (message.role === 'user') {
    return (
      <div className='message mt-2 text-right'>
        <div className='group'>
          <div className='inline-block whitespace-pre-wrap break-all rounded-t-3xl rounded-l-3xl bg-gray-100 px-4 py-2 text-left dark:bg-gray-600 dark:text-white'>
            {typeof message.content === 'string'
              ? message.content
              : isImageContentArray(message.content) &&
                message.content.map((value, contentIndex) => {
                  return (
                    <Fragment key={contentIndex}>
                      <div>{value.type === 'text' && value.text}</div>
                      {value.type === 'image_url' && (
                        <img src={value.image_url.url} alt='upload-img' className='my-1 max-w-3xs border' />
                      )}
                    </Fragment>
                  )
                })}
          </div>
          <MessageActionBar copied={copied} disabled={disabled} align='right'>
            <CopyMessageButton
              copied={copied}
              onClick={() => onCopyMessage(typeof message.content === 'string' ? message.content : '', index)}
            />
            <button
              type='button'
              className='flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-[background-color,color] duration-200 ease-out hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
              onClick={() => onDeleteMessage?.(index)}
              aria-label='Delete message'
            >
              <DeleteIcon size={20} />
            </button>
          </MessageActionBar>
        </div>
      </div>
    )
  }

  const generatedFiles = message.role === 'assistant' ? (message.metadata.generatedFiles ?? []) : []
  const assistantContextValue =
    message.role === 'assistant' && message.id && conversationId && onSaveGeneratedFile
      ? {
          messageId: message.id,
          conversationId,
          generatedFiles,
          cursor: cursorRef.current,
          disabled: savingConversation,
          canSaveGeneratedFile,
          onSave: (params: SaveGeneratedFileRequest) => onSaveGeneratedFile(index, params),
        }
      : null

  const markdownBody = (
    <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={markdownComponents}>
      {message.content}
    </ReactMarkdown>
  )

  return (
    <div className='flex'>
      <div className='flex h-8 w-8 justify-center rounded-full border border-gray-300 bg-white align-center dark:border-gray-600 dark:bg-gray-800'>
        <ChatbotIcon size={32} className='stroke-gray-600 dark:stroke-white' />
      </div>
      <div className='message group ml-2 min-w-0 flex-1 text-left'>
        {message.reasoningContent && <ReasoningSection content={message.reasoningContent} />}
        {markdownPreview ? (
          <div className='prose mt-1 max-w-(--breakpoint-md) break-all'>
            <AssistantCodeBlockContext.Provider value={assistantContextValue}>
              {markdownBody}
            </AssistantCodeBlockContext.Provider>
          </div>
        ) : (
          <div className='message text-left'>
            <p className='wrap-break-word mt-1 inline-block whitespace-pre-wrap break-all'>{message.content}</p>
          </div>
        )}
        <MessageActionBar copied={copied}>
          <CopyMessageButton copied={copied} onClick={() => onCopyMessage(message.content, index)} />
        </MessageActionBar>
        <ChatResults metadata={message.metadata} />
      </div>
    </div>
  )
}

export const MessageRenderer = memo(
  MessageRendererComponent,
  (prevProps, nextProps) =>
    prevProps.message === nextProps.message &&
    prevProps.index === nextProps.index &&
    prevProps.conversationId === nextProps.conversationId &&
    prevProps.canSaveGeneratedFile === nextProps.canSaveGeneratedFile &&
    prevProps.markdownPreview === nextProps.markdownPreview &&
    prevProps.copied === nextProps.copied &&
    prevProps.disabled === nextProps.disabled &&
    prevProps.savingConversation === nextProps.savingConversation &&
    prevProps.onCopyMessage === nextProps.onCopyMessage &&
    prevProps.onDeleteMessage === nextProps.onDeleteMessage &&
    prevProps.onSaveGeneratedFile === nextProps.onSaveGeneratedFile
)
