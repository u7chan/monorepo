import { CheckIcon } from '#/client/components/svg/check-icon'
import { CloseIcon } from '#/client/components/svg/close-icon'
import { CopyIcon } from '#/client/components/svg/copy-icon'
import { useLockBodyScroll } from '#/client/hooks/use-lock-body-scroll'
import type { Message } from '#/types'
import { useEffect, useState } from 'react'

interface MessagesDumpViewerProps {
  messages: Message[]
  open: boolean
  onClose: () => void
}

export function MessagesDumpViewer({ messages, open, onClose }: MessagesDumpViewerProps) {
  const [copied, setCopied] = useState(false)

  useLockBodyScroll(open)

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
