import type { AssistantMetadata } from '#/types'
import { memo, useState } from 'react'

interface ChatResultsProps {
  metadata: AssistantMetadata
}

function formatResponseTime(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

const badgeClass = 'flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'

function ChatResultsComponent({ metadata }: ChatResultsProps) {
  const [open, setOpen] = useState(false)

  if (!metadata.model) {
    return null
  }

  const { model, finishReason, responseTimeMs, usage } = metadata

  return (
    <div className='mt-2'>
      <button
        type='button'
        className='flex cursor-pointer flex-wrap items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{model}</span>
        {responseTimeMs !== undefined && (
          <>
            <span>/</span>
            <span>{formatResponseTime(responseTimeMs)}</span>
          </>
        )}
        <span className='ml-0.5'>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className='mt-1 flex flex-wrap gap-1'>
          {finishReason && (
            <div className={badgeClass}>
              <span className='mr-1'>finish_reason:</span>
              <span>{finishReason}</span>
            </div>
          )}
          <div className={badgeClass}>
            <span className='mr-1'>usage:</span>
            <span className='mr-0.5'>(input:</span>
            <span>{usage.promptTokens ?? '--'}</span>
            <span className='mr-0.5'>/</span>
            <span className='mr-0.5'>output:</span>
            <span>{usage.completionTokens ?? '--'}</span>
            {usage.reasoningTokens !== undefined && (
              <>
                <span className='mr-0.5'>/</span>
                <span className='mr-0.5'>reasoning:</span>
                <span>{usage.reasoningTokens}</span>
              </>
            )}
            <span>)</span>
          </div>
        </div>
      )}
    </div>
  )
}

export const ChatResults = memo(ChatResultsComponent)
