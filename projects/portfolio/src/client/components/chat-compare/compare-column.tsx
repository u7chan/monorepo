import { useCallback, useState } from 'react'
import { copyToClipboard } from '#/client/components/chat/copy-to-clipboard'
import { CheckIcon } from '#/client/components/svg/check-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import type { ApiChatMessage, ImageContent, TextContent } from '#/types'
import type { ModelStreamState } from './hooks/use-compare-state'

interface CompareColumnProps {
  state: ModelStreamState
}

function formatResponseTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function renderMessageContent(content: ApiChatMessage['content']) {
  if (typeof content === 'string') {
    return content
  }

  return content.map((value: TextContent | ImageContent, index) => {
    if (value.type === 'text') {
      return <div key={index}>{value.text}</div>
    }

    return (
      <img
        key={index}
        src={value.image_url.url}
        alt='upload-img'
        className='my-1 max-w-3xs rounded-md border border-gray-200 dark:border-gray-600'
      />
    )
  })
}

interface CopyMessageButtonProps {
  copied: boolean
  onClick: () => void
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

function CompareMessage({ copied, message, onCopy }: { copied: boolean; message: ApiChatMessage; onCopy: () => void }) {
  if (message.role === 'system') {
    return null
  }

  if (message.role === 'user') {
    return (
      <div className='message mt-2 text-right'>
        <div className='inline-block max-w-full whitespace-pre-wrap break-all rounded-t-3xl rounded-l-3xl bg-gray-100 px-4 py-2 text-left text-sm text-gray-900 dark:bg-gray-600 dark:text-white'>
          {renderMessageContent(message.content)}
        </div>
      </div>
    )
  }

  return (
    <div className='message group mt-2 text-left'>
      <p className='whitespace-pre-wrap break-all text-sm text-gray-900 dark:text-gray-100'>{message.content}</p>
      <div
        className={`mt-1 ml-1 flex items-center gap-1 transition-opacity duration-200 ease-out motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 ${
          copied ? 'opacity-100' : ''
        }`}
      >
        <CopyMessageButton copied={copied} onClick={onCopy} />
      </div>
    </div>
  )
}

export function CompareColumn({ state }: CompareColumnProps) {
  const { model, status, messages, content, reasoningContent, usage, finishReason, responseTimeMs, error, retryAttempt } =
    state
  const showMeta = status === 'done' && (finishReason || usage || responseTimeMs !== null)
  const [copiedId, setCopiedId] = useState('')
  const copyMessage = useCallback(async (message: string, index: number) => {
    const id = `compare_${index}`
    setCopiedId(id)
    try {
      await copyToClipboard(message)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } catch (error) {
      alert(error)
    }
    setCopiedId('')
  }, [])

  return (
    <div className='flex min-w-0 flex-1 flex-col overflow-hidden border-r border-gray-200 last:border-r-0 dark:border-gray-700'>
      <div className='shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-gray-200 px-3 py-2 text-center font-medium text-sm dark:border-gray-700 dark:text-gray-200'>
        {model}
        {status === 'streaming' && (
          <span className='ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-primary-600 align-middle' />
        )}
        {status === 'retrying' && (
          <span className='ml-2 rounded-full bg-amber-100 px-2 py-0.5 align-middle font-medium text-[11px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'>
            Retry {retryAttempt}/1
          </span>
        )}
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto px-3 py-2'>
        {messages.map((message, index) => (
          <CompareMessage
            key={`${message.role}-${index}`}
            copied={copiedId === `compare_${index}`}
            message={message}
            onCopy={() => {
              if (message.role === 'assistant') {
                void copyMessage(message.content, index)
              }
            }}
          />
        ))}
        {error && (
          <div className='mt-2 rounded-md bg-red-50 p-2 text-red-600 text-sm dark:bg-red-900/30 dark:text-red-400'>
            {error}
          </div>
        )}
        {status === 'retrying' && (
          <div className='mt-2 rounded-md bg-amber-50 p-2 text-amber-700 text-sm dark:bg-amber-900/20 dark:text-amber-300'>
            60秒間応答がなかったため再試行しています。
          </div>
        )}
        {status === 'streaming' && (
          <>
            {reasoningContent && (
              <details className='mt-2 mb-2'>
                <summary className='cursor-pointer text-xs text-gray-400 dark:text-gray-500'>
                  Reasoning ({reasoningContent.length} chars)
                </summary>
                <pre className='mt-1 whitespace-pre-wrap break-all text-xs text-gray-500 dark:text-gray-400'>
                  {reasoningContent}
                </pre>
              </details>
            )}
            {content ? (
              <p className='mt-2 whitespace-pre-wrap break-all text-sm text-gray-900 dark:text-gray-100'>{content}</p>
            ) : (
              <p className='animate-pulse text-gray-400 text-sm dark:text-gray-500'>...</p>
            )}
          </>
        )}
        {showMeta && (
          <div className='mt-3 border-t border-gray-100 pt-2 dark:border-gray-700'>
            <div className='flex flex-wrap gap-1 text-xs text-gray-400 dark:text-gray-500'>
              {finishReason && (
                <span className='rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-700'>finish: {finishReason}</span>
              )}
              {responseTimeMs !== null && (
                <span className='rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-700'>
                  {formatResponseTime(responseTimeMs)}
                </span>
              )}
              {usage && (
                <span className='rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-700'>
                  in:{usage.promptTokens ?? '-'} / out:{usage.completionTokens ?? '-'} / total:
                  {usage.totalTokens ?? '-'}
                  {usage.reasoningTokens !== undefined && <> / reas:{usage.reasoningTokens}</>}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
