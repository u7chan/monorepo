import { ChevronRightIcon } from '#/client/components/svg/chevron-right-icon'
import { useState } from 'react'

interface ReasoningSectionProps {
  content: string
  isStreaming?: boolean
  defaultOpen?: boolean
}

export function ReasoningSection({ content, isStreaming = false, defaultOpen = false }: ReasoningSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className='mb-1 text-xs'>
      <button
        type='button'
        className='flex cursor-pointer items-center gap-1 rounded-sm px-0.5 text-gray-400 transition-colors hover:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-400 dark:hover:text-gray-300 dark:focus-visible:ring-gray-500'
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className={`inline-flex transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}>
          <ChevronRightIcon />
        </span>
        <span>reasoning</span>
        {isStreaming && (
          <span className='inline-block h-3 w-3 animate-spin rounded-full border border-gray-400 border-t-transparent dark:border-gray-500 dark:border-t-transparent' />
        )}
      </button>
      {isOpen && (
        <div className='mt-1 wrap-break-word whitespace-pre-line break-all text-gray-400 dark:text-gray-200'>
          {content}
        </div>
      )}
    </div>
  )
}
