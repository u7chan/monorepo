import { useEffect, useState } from 'react'
import { useLockBodyScroll } from '#/client/shared/hooks/use-lock-body-scroll'
import { CheckIcon } from '#/client/shared/icons/check-icon'
import { CloseIcon } from '#/client/shared/icons/close-icon'
import { CopyIcon } from '#/client/shared/icons/copy-icon'
import type { ApiChatMessage, Message } from '#/types'

interface MessagesDumpViewerProps {
  messages: Message[]
  apiContextMessages?: ApiChatMessage[]
  open: boolean
  onClose: () => void
}

export function MessagesDumpViewer({ messages, apiContextMessages, open, onClose }: MessagesDumpViewerProps) {
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<'history' | 'apiContext'>('history')

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

  const hasApiContext = apiContextMessages !== undefined
  const visibleData = view === 'apiContext' && hasApiContext ? apiContextMessages : messages
  const json = JSON.stringify(visibleData, null, 2)

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
        className='relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800'
        role='dialog'
        aria-modal='true'
        aria-label='Messages dump viewer'
      >
        <div className='flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-700'>
          <div className='flex min-w-0 items-center gap-3'>
            <span className='text-sm font-medium text-gray-900 dark:text-gray-100'>Messages Dump</span>
            {hasApiContext && (
              <div className='flex rounded-md border border-gray-200 bg-gray-50 p-0.5 dark:border-gray-700 dark:bg-gray-900'>
                <button
                  type='button'
                  className={`rounded px-2 py-1 text-xs ${
                    view === 'history'
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`}
                  onClick={() => setView('history')}
                >
                  Saved History
                </button>
                <button
                  type='button'
                  className={`rounded px-2 py-1 text-xs ${
                    view === 'apiContext'
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`}
                  onClick={() => setView('apiContext')}
                >
                  API Context
                </button>
              </div>
            )}
          </div>
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
        {hasApiContext && view === 'apiContext' && (
          <div className='border-b border-gray-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800 dark:border-gray-700 dark:bg-emerald-900/30 dark:text-emerald-200'>
            このビューは実際に送信した API コンテキストです。除外された過去画像の Base64 は表示されません。
          </div>
        )}
        {hasApiContext && view === 'history' && (
          <div className='border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300'>
            このビューは保存済みの会話履歴です。履歴保存方針により画像 Base64 を含みます。
          </div>
        )}
        <div className='messages-dump-scroll overflow-auto bg-gray-50 p-4 dark:bg-gray-800'>
          <pre className='w-max min-w-full pr-4 text-xs text-gray-800 dark:text-gray-200'>
            <code>{json}</code>
          </pre>
        </div>
      </div>
    </div>
  )
}
