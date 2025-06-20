import type { PropsWithChildren, ReactNode } from 'react'

interface Props {
  conversations?: ReactNode
}

export function ChatLayout({ conversations, children }: PropsWithChildren<Props>) {
  return conversations ? (
    <div className='flex'>
      <div className='h-screen w-40 border-r'>{conversations}</div>
      <div className='flex-1'>{children}</div>
    </div>
  ) : (
    children
  )
}
