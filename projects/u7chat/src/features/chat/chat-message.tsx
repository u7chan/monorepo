'use client'

import { useState } from 'react'
import { generate } from './chat-actions'
import { readStreamableValue } from '@ai-sdk/rsc'
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
            <div className='rounded bg-gray-100 p-2 break-words whitespace-pre-wrap dark:bg-gray-800'>{user}</div>
          </div>
        )}
        <Streamdown className='break-words whitespace-pre-wrap'>{assistant}</Streamdown>
        <div ref={scrollContainer}></div>
      </div>
    </div>
  )
}
