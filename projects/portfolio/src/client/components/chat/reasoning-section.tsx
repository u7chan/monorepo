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
        aria-expanded={isOpen}
      >
        <span className={`inline-flex transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}>
          <ChevronRightIcon />
        </span>
        <span>reasoning</span>
        {isStreaming && (
          <span className='inline-block h-3 w-3 animate-spin rounded-full border border-gray-400 border-t-transparent dark:border-gray-500 dark:border-t-transparent' />
        )}
      </button>
      <div
        aria-hidden={!isOpen}
        className={`grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none ${
          isOpen ? 'mt-1 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className='min-h-0'>
          <div
            className={`wrap-break-word whitespace-pre-line break-all text-gray-400 transition-transform duration-200 ease-out motion-reduce:transition-none dark:text-gray-200 ${
              isOpen ? 'translate-y-0' : '-translate-y-1'
            }`}
          >
            {content}
          </div>
        </div>
      </div>
    </div>
  )
}
