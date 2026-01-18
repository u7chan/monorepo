import type { PropsWithChildren, ReactNode } from 'react'

interface Props {
  conversations?: ReactNode
}

export function ChatLayout({ conversations, children }: PropsWithChildren<Props>) {
  return conversations ? (
    <div className='flex bg-white dark:bg-gray-900'>
      <div className='h-screen w-40 border-gray-200 border-r bg-white dark:border-gray-700 dark:bg-gray-800'>
        {conversations}
      </div>
      <div className='flex-1 bg-white dark:bg-gray-900'>{children}</div>
    </div>
  ) : (
    <div className='bg-white dark:bg-gray-900'>{children}</div>
  )
}
