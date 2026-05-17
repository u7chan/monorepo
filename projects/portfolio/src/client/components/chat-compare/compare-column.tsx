import type { ModelStreamState } from './hooks/use-compare-state'
import type { ApiChatMessage, ImageContent, TextContent } from '#/types'

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

function CompareMessage({ message }: { message: ApiChatMessage }) {
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
    <div className='message mt-2 text-left'>
      <p className='whitespace-pre-wrap break-all text-sm text-gray-900 dark:text-gray-100'>{message.content}</p>
    </div>
  )
}

export function CompareColumn({ state }: CompareColumnProps) {
  const { model, status, messages, content, reasoningContent, usage, finishReason, responseTimeMs, error } = state
  const showMeta = status === 'done' && (finishReason || usage || responseTimeMs !== null)

  return (
    <div className='flex min-w-0 flex-1 flex-col overflow-hidden border-r border-gray-200 last:border-r-0 dark:border-gray-700'>
      <div className='shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-gray-200 px-3 py-2 text-center font-medium text-sm dark:border-gray-700 dark:text-gray-200'>
        {model}
        {status === 'streaming' && (
          <span className='ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-primary-600 align-middle' />
        )}
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto px-3 py-2'>
        {messages.map((message, index) => (
          <CompareMessage key={`${message.role}-${index}`} message={message} />
        ))}
        {error && (
          <div className='mt-2 rounded-md bg-red-50 p-2 text-red-600 text-sm dark:bg-red-900/30 dark:text-red-400'>
            {error}
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
