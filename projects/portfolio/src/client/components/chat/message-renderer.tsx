import { ChatResults } from '#/client/components/chat/chat-results'
import { CodeBlockRenderer, MarkdownLink } from '#/client/components/chat/code-block-renderer'
import { ReasoningSection } from '#/client/components/chat/reasoning-section'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { DeleteIcon } from '#/client/components/svg/delete-icon'
import type { Message } from '#/types'
import { isImageContentArray } from '#/types'
import { Fragment, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough'
import remarkGfm from 'remark-gfm'

const markdownRemarkPlugins = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough]
const markdownComponents = {
  a: MarkdownLink,
  code: CodeBlockRenderer,
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
}

interface MessageRendererProps {
  message: Message
  index: number
  markdownPreview: boolean
  copied: boolean
  disabled?: boolean
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage?: (index: number) => void
}

function MessageRendererComponent({
  message,
  index,
  markdownPreview,
  copied,
  disabled,
  onCopyMessage,
  onDeleteMessage,
}: MessageRendererProps) {
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
          <div
            className={`mt-1 ml-1 transition-opacity duration-200 ease-in md:opacity-0 md:group-hover:opacity-100 ${copied ? 'opacity-100' : ''} ${disabled ? 'invisible' : ''}`}
          >
            <button
              type='button'
              className='cursor-pointer p-1'
              onClick={() => onCopyMessage(typeof message.content === 'string' ? message.content : '', index)}
              disabled={copied}
            >
              {copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
            </button>
            <button type='button' className='cursor-pointer p-1' onClick={() => onDeleteMessage?.(index)}>
              <DeleteIcon size={20} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='flex'>
      <div className='flex h-8 w-8 justify-center rounded-full border border-gray-300 bg-white align-center dark:border-gray-600 dark:bg-gray-800'>
        <ChatbotIcon size={32} className='stroke-gray-600 dark:stroke-white' />
      </div>
      <div className='message group ml-2 min-w-0 flex-1 text-left'>
        {message.reasoningContent && <ReasoningSection content={message.reasoningContent} />}
        {markdownPreview ? (
          <div className='prose mt-1 max-w-(--breakpoint-md) break-all'>
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={markdownComponents}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className='message text-left'>
            <p className='wrap-break-word mt-1 inline-block whitespace-pre-wrap break-all'>{message.content}</p>
          </div>
        )}
        <div
          className={`mt-1 ml-1 transition-opacity duration-200 ease-in md:opacity-0 md:group-hover:opacity-100 ${copied ? 'opacity-100' : ''}`}
        >
          <button
            type='button'
            className='cursor-pointer p-1'
            onClick={() => onCopyMessage(message.content, index)}
            disabled={copied}
          >
            {copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
          </button>
        </div>
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
    prevProps.markdownPreview === nextProps.markdownPreview &&
    prevProps.copied === nextProps.copied &&
    prevProps.disabled === nextProps.disabled &&
    prevProps.onCopyMessage === nextProps.onCopyMessage &&
    prevProps.onDeleteMessage === nextProps.onDeleteMessage
)
