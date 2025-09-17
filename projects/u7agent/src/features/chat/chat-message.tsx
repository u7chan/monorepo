'use client'

import { Streamdown } from 'streamdown'

interface ChatMessageProps {
  user: string
  assistant: string
  scrollContainer?: React.RefObject<HTMLDivElement | null>
}

export function ChatMessage({ user, assistant, scrollContainer }: ChatMessageProps) {
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex max-h-[400px] flex-col gap-2 overflow-y-auto p-4'>
        {user && (
          <div className='flex justify-end'>
            <div className='bg-chat-bubble rounded-3xl rounded-tr-sm px-4 py-3 break-words whitespace-pre-wrap'>
              {user}
            </div>
          </div>
        )}
        <Streamdown className='break-words whitespace-pre-wrap'>{assistant}</Streamdown>
        <div ref={scrollContainer}></div>
      </div>
    </div>
  )
}
