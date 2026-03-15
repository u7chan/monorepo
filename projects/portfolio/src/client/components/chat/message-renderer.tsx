import { CodeBlockRenderer, MarkdownLink } from '#/client/components/chat/code-block-renderer'
import { ChatbotIcon } from '#/client/components/svg/chatbot-icon'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { DeleteIcon } from '#/client/components/svg/delete-icon'
import type { Settings } from '#/client/storage/remote-storage-settings'
import type { ChatMessage } from '#/types'
import { isImageContentArray } from '#/types'
import { Fragment } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MessageRendererProps {
  message: ChatMessage
  index: number
  settings: Settings
  copied: boolean
  disabled?: boolean
  onCopyMessage: (message: string, index: number) => void
  onDeleteMessage?: (index: number) => void
}

export function MessageRenderer({
  message,
  index,
  settings,
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
            className={`mt-1 ml-1 transition-opacity duration-200 ease-in group-hover:opacity-100 ${copied ? 'opacity-100' : 'opacity-0'} ${disabled ? 'invisible' : ''}`}
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
      <div className='flex h-8 w-8 justify-center rounded-full border border-gray-300 bg-white align-center dark:border-gray-600 dark:bg-gray-900'>
        <ChatbotIcon size={32} className='stroke-gray-600 dark:stroke-gray-300' />
      </div>
      <div className='message group ml-2 text-left'>
        {message.reasoning_content && (
          <div className='wrap-break-word whitespace-pre-line break-all text-gray-400 text-xs dark:text-gray-200'>
            {message.reasoning_content}
          </div>
        )}
        {settings.markdownPreview ? (
          <div className='prose mt-1 max-w-(--breakpoint-md) break-all'>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: MarkdownLink,
                code: CodeBlockRenderer,
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className='message text-left'>
            <p className='wrap-break-word mt-1 inline-block whitespace-pre-wrap break-all'>{message.content}</p>
          </div>
        )}
        <div
          className={`mt-1 ml-1 transition-opacity duration-200 ease-in group-hover:opacity-100 ${copied ? 'opacity-100' : 'opacity-0'}`}
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
      </div>
    </div>
  )
}
