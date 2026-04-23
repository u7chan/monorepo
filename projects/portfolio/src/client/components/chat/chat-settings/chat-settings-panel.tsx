import { CloseIcon } from '#/client/components/svg/close-icon'
import type { ReactNode } from 'react'

interface Props {
  show: boolean
  children: ReactNode
  onClose: () => void
}

export function ChatSettingsPanel({ show, children, onClose }: Props) {
  return (
    <>
      {/* Overlay Background */}
      {show && (
        <div
          className='fixed inset-0 z-40 bg-black/50 transition-opacity duration-300'
          onClick={onClose}
          aria-hidden='true'
        />
      )}

      {/* Slide-in Panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full transform bg-white shadow-2xl transition-transform duration-300 ease-in-out sm:w-[400px] lg:w-[450px] dark:bg-gray-800 ${
          show ? 'translate-x-0' : 'translate-x-full'
        }`}
        role='dialog'
        aria-modal='true'
        aria-labelledby='chat-settings-title'
      >
        {/* Header */}
        <div className='flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700'>
          <h2 id='chat-settings-title' className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
            Chat Settings
          </h2>
          <button
            type='button'
            onClick={onClose}
            className='flex cursor-pointer items-center justify-center rounded-md p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 dark:focus:ring-gray-500'
            aria-label='Close settings'
          >
            <CloseIcon className='fill-current' />
          </button>
        </div>

        {/* Settings Content - Scrollable */}
        <div
          className='h-[calc(100%-4rem)] overflow-y-auto p-4 pb-[env(safe-area-inset-bottom,0px)]'
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        >
          {children}
        </div>
      </div>
    </>
  )
}
