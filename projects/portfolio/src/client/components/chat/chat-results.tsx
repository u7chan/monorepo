import { CheckIcon } from '#/client/components/svg/check-icon'
import { ChevronRightIcon } from '#/client/components/svg/chevron-right-icon'
import { CloseIcon } from '#/client/components/svg/close-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { EyeIcon } from '#/client/components/svg/eye-icon'
import type { AssistantMetadata, Message } from '#/types'
import { memo, useEffect, useState } from 'react'

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

function MessagesDumpViewer({ messages, open, onClose }: { messages: Message[]; open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  if (!open) {
    return null
  }

  const json = JSON.stringify(messages, null, 2)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(json)
    setCopied(true)
  }

  const iconButtonClass =
    'flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-[background-color,color] duration-200 ease-out hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-gray-500'

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center p-4'>
      <div className='fixed inset-0 bg-black/50' onClick={onClose} aria-hidden='true' />
      <div
        className='relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800'
        role='dialog'
        aria-modal='true'
        aria-label='Messages dump viewer'
      >
        <div className='flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-700'>
          <span className='text-sm font-medium text-gray-900 dark:text-gray-100'>Messages Dump</span>
          <div className='flex items-center gap-1'>
            <button
              type='button'
              className={`${iconButtonClass} ${copied ? 'text-emerald-600 dark:text-emerald-400' : ''}`}
              onClick={handleCopy}
              disabled={copied}
              aria-label={copied ? 'Copied' : 'Copy JSON'}
            >
              <span
                aria-hidden='true'
                className={`absolute transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
                  copied ? '-translate-y-0.5 scale-90 opacity-0' : 'translate-y-0 scale-100 opacity-100'
                }`}
              >
                <CopyIcon size={18} className='stroke-current' />
              </span>
              <span
                aria-hidden='true'
                className={`absolute transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
                  copied ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-0.5 scale-90 opacity-0'
                }`}
              >
                <CheckIcon size={18} className='stroke-current' />
              </span>
            </button>
            <button type='button' className={iconButtonClass} onClick={onClose} aria-label='Close viewer'>
              <CloseIcon size={20} />
            </button>
          </div>
        </div>
        <div className='overflow-auto p-4'>
          <pre className='text-xs text-gray-800 dark:text-gray-200'>
            <code>{json}</code>
          </pre>
        </div>
      </div>
    </div>
  )
}

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
