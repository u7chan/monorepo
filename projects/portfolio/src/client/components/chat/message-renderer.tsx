import { Fragment, memo, type ReactNode, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough'
import remarkGfm from 'remark-gfm'
import {
  AssistantAwareCodeBlock,
  AssistantCodeBlockContext,
  type SaveGeneratedFileRequest,
} from '#/client/components/chat/assistant-code-block'
import { ChatResults } from '#/client/components/chat/chat-results'
import {
  CodeBlockOpenStateContext,
  MarkdownLink,
  type CodeBlockOpenBlocks,
  type CodeBlockOpenChangeHandler,
} from '#/client/components/chat/code-block-renderer'
import { getUserMessageText } from '#/client/components/chat/edit-message'
import { ReasoningSection } from '#/client/components/chat/reasoning-section'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CloseIcon } from '#/client/components/svg/close-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { DeleteIcon } from '#/client/components/svg/delete-icon'
import { EditIcon } from '#/client/components/svg/edit-icon'
import type { GeneratedCodeFile, Message } from '#/types'
import { isImageContentArray } from '#/types'

const markdownRemarkPlugins = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough]
const markdownRehypePlugins = [rehypeSanitize]
const markdownComponents = {
  a: MarkdownLink,
  code: AssistantAwareCodeBlock,
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
}

function ImageContextBadge({ sendImagesOnlyOnce }: { sendImagesOnlyOnce?: boolean }) {
  const contextTarget = sendImagesOnlyOnce === false
  return (
    <span
      className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] leading-none ${
        contextTarget
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'
          : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
      }`}
    >
      {contextTarget ? 'コンテキスト対象' : '履歴のみ'}
    </span>
  )
}

interface MessageRendererProps {
  message: Message
  index: number
  messages: Message[]
  conversationId: string | null
  canSaveGeneratedFile?: boolean
  markdownPreview: boolean
  sendImagesOnlyOnce?: boolean
  copied: boolean
  disabled?: boolean
  savingConversation?: boolean
  codeBlockOpenBlocks?: CodeBlockOpenBlocks
  onCodeBlockOpenChange?: CodeBlockOpenChangeHandler
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage?: (index: number) => void
  onEditMessage?: (index: number, nextText: string) => Promise<void> | void
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
  messages,
  conversationId,
  canSaveGeneratedFile,
  markdownPreview,
  sendImagesOnlyOnce,
  copied,
  disabled,
  savingConversation,
  codeBlockOpenBlocks,
  onCodeBlockOpenChange,
  onCopyMessage,
  onDeleteMessage,
  onEditMessage,
  onSaveGeneratedFile,
}: MessageRendererProps) {
  // fenced code block 用の cursor。render のたびに 0 にリセットし、
  // 子の AssistantAwareCodeBlock が順序どおり blockIndex を取得できるようにする。
  const cursorRef = useRef({ current: 0 })
  cursorRef.current.current = 0
  const codeBlockCursorRef = useRef({ current: 0 })
  codeBlockCursorRef.current.current = 0
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(() => (message.role === 'user' ? getUserMessageText(message) : ''))
  const [isSavingEdit, setIsSavingEdit] = useState(false)

  useEffect(() => {
    if (!isEditing || !disabled) {
      return
    }

    if (message.role === 'user') {
      setEditText(getUserMessageText(message))
    }
    setIsEditing(false)
  }, [disabled, isEditing, message])

  if (message.role === 'system') {
    return null
  }

  if (message.role === 'user') {
    const canSaveEdit = editText.trim().length > 0 && !disabled && !isSavingEdit
    const userMessageText = getUserMessageText(message)

    const handleStartEdit = () => {
      setEditText(userMessageText)
      setIsEditing(true)
    }

    const handleCancelEdit = () => {
      setEditText(userMessageText)
      setIsEditing(false)
    }

    const handleSaveEdit = async () => {
      if (!canSaveEdit) {
        return
      }

      setIsEditing(false)
      setIsSavingEdit(true)
      try {
        await onEditMessage?.(index, editText)
      } finally {
        setIsSavingEdit(false)
      }
    }

    return (
      <div className='message mt-2 text-right'>
        <div className='group'>
          <div className='inline-block max-w-full whitespace-pre-wrap break-all rounded-t-3xl rounded-l-3xl bg-gray-100 px-4 py-2 text-left dark:bg-gray-600 dark:text-white'>
            {isEditing ? (
              <textarea
                aria-label='Edit message text'
                value={editText}
                rows={Math.min(Math.max(editText.split('\n').length, 2), 8)}
                className='min-w-72 max-w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:border-primary-700 focus:ring-2 focus:ring-primary-200 dark:border-gray-500 dark:bg-gray-700 dark:text-gray-100 dark:focus:border-primary-500 dark:focus:ring-primary-800'
                disabled={disabled || isSavingEdit}
                onChange={(event) => setEditText(event.currentTarget.value)}
              />
            ) : typeof message.content === 'string' ? (
              message.content
            ) : (
              isImageContentArray(message.content) &&
              message.content.map((value, contentIndex) => {
                return (
                  <Fragment key={contentIndex}>
                    <div>{value.type === 'text' && value.text}</div>
                    {value.type === 'image_url' && (
                      <div className='my-1 inline-flex flex-col items-start'>
                        <img src={value.image_url.url} alt='upload-img' className='max-w-3xs border' />
                        <ImageContextBadge
                          sendImagesOnlyOnce={message.metadata.sendImagesOnlyOnce ?? sendImagesOnlyOnce}
                        />
                      </div>
                    )}
                  </Fragment>
                )
              })
            )}
          </div>
          <MessageActionBar copied={copied} disabled={disabled} align='right'>
            {isEditing ? (
              <>
                <button
                  type='button'
                  className='flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-[background-color,color] duration-200 ease-out hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:cursor-default disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
                  onClick={handleSaveEdit}
                  disabled={!canSaveEdit}
                  aria-label='Save edited message'
                >
                  <CheckIcon size={20} className='stroke-current' />
                </button>
                <button
                  type='button'
                  className='flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-[background-color,color] duration-200 ease-out hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:cursor-default disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
                  onClick={handleCancelEdit}
                  disabled={isSavingEdit}
                  aria-label='Cancel editing message'
                >
                  <CloseIcon size={20} className='fill-current' />
                </button>
              </>
            ) : (
              <>
                <CopyMessageButton copied={copied} onClick={() => onCopyMessage(userMessageText, index)} />
                <button
                  type='button'
                  className='flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-[background-color,color] duration-200 ease-out hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
                  onClick={handleStartEdit}
                  aria-label='Edit message'
                >
                  <EditIcon size={20} className='stroke-current' />
                </button>
                <button
                  type='button'
                  className='flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-[background-color,color] duration-200 ease-out hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'
                  onClick={() => onDeleteMessage?.(index)}
                  aria-label='Delete message'
                >
                  <DeleteIcon size={20} />
                </button>
              </>
            )}
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
    <CodeBlockOpenStateContext.Provider
      value={
        message.id && codeBlockOpenBlocks && onCodeBlockOpenChange
          ? {
              messageId: message.id,
              cursor: codeBlockCursorRef.current,
              openBlocks: codeBlockOpenBlocks,
              onOpenChange: onCodeBlockOpenChange,
            }
          : null
      }
    >
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={markdownComponents}
      >
        {message.content}
      </ReactMarkdown>
    </CodeBlockOpenStateContext.Provider>
  )
  const dumpMessages = messages.slice(0, index + 1)

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
            <p className='wrap-break-word mt-1 inline-block whitespace-pre-wrap break-all text-gray-900 dark:text-gray-100'>
              {message.content}
            </p>
          </div>
        )}
        <MessageActionBar copied={copied}>
          <CopyMessageButton copied={copied} onClick={() => onCopyMessage(message.content, index)} />
        </MessageActionBar>
        <ChatResults metadata={message.metadata} messages={dumpMessages} />
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
    prevProps.sendImagesOnlyOnce === nextProps.sendImagesOnlyOnce &&
    prevProps.copied === nextProps.copied &&
    prevProps.disabled === nextProps.disabled &&
    prevProps.savingConversation === nextProps.savingConversation &&
    prevProps.codeBlockOpenBlocks === nextProps.codeBlockOpenBlocks &&
    prevProps.onCodeBlockOpenChange === nextProps.onCodeBlockOpenChange &&
    prevProps.onCopyMessage === nextProps.onCopyMessage &&
    prevProps.onDeleteMessage === nextProps.onDeleteMessage &&
    prevProps.onEditMessage === nextProps.onEditMessage &&
    prevProps.onSaveGeneratedFile === nextProps.onSaveGeneratedFile
)
