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
          {/* Close button - visible on mobile */}
          <button
            type='button'
            onClick={onClose}
            className='rounded-md p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 sm:hidden dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200'
            aria-label='Close settings'
          >
            <svg className='h-6 w-6' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
            </svg>
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
