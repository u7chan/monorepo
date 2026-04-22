import { ChevronRightIcon } from '#/client/components/svg/chevron-right-icon'
import { MessagesDumpViewer } from '#/client/components/chat/messages-dump-viewer'
import { EyeIcon } from '#/client/components/svg/eye-icon'
import type { AssistantMetadata, Message } from '#/types'
import { memo, useState } from 'react'

interface ChatResultsProps {
  metadata: AssistantMetadata
  messages: Message[]
}

function formatResponseTime(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

const badgeClass = 'flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-700 dark:text-gray-300'

function ChatResultsComponent({ metadata, messages }: ChatResultsProps) {
  const [open, setOpen] = useState(false)
  const [dumpOpen, setDumpOpen] = useState(false)

  if (!metadata.model) {
    return null
  }

  const { model, finishReason, responseTimeMs, usage } = metadata

  return (
    <div className='mt-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <button
          type='button'
          className='flex cursor-pointer flex-wrap items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
        >
          <span>{model}</span>
          {responseTimeMs !== undefined && (
            <>
              <span>/</span>
              <span>{formatResponseTime(responseTimeMs)}</span>
            </>
          )}
          <span className={`ml-0.5 inline-flex transition-transform duration-200 ${open ? '-rotate-90' : 'rotate-90'}`}>
            <ChevronRightIcon />
          </span>
        </button>
        <button
          type='button'
          className='flex cursor-pointer items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'
          onClick={() => setDumpOpen(true)}
          aria-label='Open messages dump viewer'
        >
          <span>messages: ({messages.length})</span>
          <EyeIcon size={14} className='stroke-current' />
        </button>
      </div>
      <div
        aria-hidden={!open}
        className={`grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none ${
          open ? 'mt-1 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className='min-h-0'>
          <div
            className={`flex flex-wrap gap-1 transition-transform duration-200 ease-out motion-reduce:transition-none ${
              open ? 'translate-y-0' : '-translate-y-1'
            }`}
          >
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
              <span className='mr-0.5'>/</span>
              <span className='mr-0.5'>total:</span>
              <span>{usage.totalTokens ?? '--'}</span>
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
        </div>
      </div>
      <MessagesDumpViewer messages={messages} open={dumpOpen} onClose={() => setDumpOpen(false)} />
    </div>
  )
}

export const ChatResults = memo(ChatResultsComponent)
