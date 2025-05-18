import type { ReactNode } from 'react'
import { forwardRef } from 'react'

interface MessageAreaScrollProps {
  children?: ReactNode
}

export const MessageAreaScroll = forwardRef<HTMLDivElement, MessageAreaScrollProps>(
  function MessageAreaScroll({ children }, ref) {
    return (
      <div className='flex flex-1 flex-col overflow-y-auto p-4'>
        {children}
        <div ref={ref} />
      </div>
    )
  },
)
