import type { ModelStreamState } from './hooks/use-compare-state'

interface CompareColumnProps {
  state: ModelStreamState
}

function formatResponseTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function CompareColumn({ state }: CompareColumnProps) {
  const { model, status, content, reasoningContent, usage, finishReason, responseTimeMs, error } = state
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
        {error && (
          <div className='rounded-md bg-red-50 p-2 text-red-600 text-sm dark:bg-red-900/30 dark:text-red-400'>
            {error}
          </div>
        )}
        {(status === 'streaming' || status === 'done' || status === 'idle') && (
          <>
            {reasoningContent && (
              <details className='mb-2'>
                <summary className='cursor-pointer text-xs text-gray-400 dark:text-gray-500'>
                  Reasoning ({reasoningContent.length} chars)
                </summary>
                <pre className='mt-1 whitespace-pre-wrap break-all text-xs text-gray-500 dark:text-gray-400'>
                  {reasoningContent}
                </pre>
              </details>
            )}
            {content ? (
              <p className='whitespace-pre-wrap break-all text-sm text-gray-900 dark:text-gray-100'>{content}</p>
            ) : status === 'streaming' ? (
              <p className='animate-pulse text-gray-400 text-sm dark:text-gray-500'>...</p>
            ) : null}
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
