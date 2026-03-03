interface ChatResultsProps {
  model?: string
  finishReason?: string
  responseTimeMs?: number
  usage?: {
    promptTokens?: number
    completionTokens?: number
  } | null
}

function formatResponseTime(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

export function ChatResults({ model, finishReason, responseTimeMs, usage }: ChatResultsProps) {
  return (
    <div className='mt-2 flex flex-wrap justify-end gap-1'>
      <div className='flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'>
        <span className='mr-1'>model:</span>
        <span>{model}</span>
      </div>
      {finishReason && (
        <div className='flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'>
          <span className='mr-1'>finish_reason:</span>
          <span>{finishReason}</span>
        </div>
      )}
      {responseTimeMs !== undefined && (
        <div className='flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'>
          <span className='mr-1'>time:</span>
          <span>{formatResponseTime(responseTimeMs)}</span>
        </div>
      )}
      <div className='flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'>
        <span className='mr-1'>usage:</span>
        <span className='mr-0.5'>(input:</span>
        <span>{usage?.promptTokens || '--'}</span>
        <span className='mr-0.5'>/</span>
        <span className='mr-0.5'>output:</span>
        <span>{usage?.completionTokens || '--'}</span>
        <span>)</span>
      </div>
    </div>
  )
}
