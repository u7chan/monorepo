import type { ReactNode } from 'react'
import { forwardRef } from 'react'

interface MessageAreaScrollProps {
  children?: ReactNode
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
}

export const MessageAreaScroll = forwardRef<HTMLDivElement, MessageAreaScrollProps>(
  function MessageAreaScroll({ children, scrollContainerRef, onScroll }, ref) {
    return (
      <div
        ref={scrollContainerRef}
        className='flex flex-1 flex-col overflow-y-auto p-4'
        onScroll={onScroll}
      >
        {children}
        <div ref={ref} />
      </div>
    )
  },
)
