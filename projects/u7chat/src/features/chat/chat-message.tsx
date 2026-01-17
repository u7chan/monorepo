'use client'

import React from 'react'
import { Streamdown } from 'streamdown'

interface ChatMessageProps {
  messages: {
    role: 'user' | 'assistant' | 'system'
    content: string
  }[]
  streamMessage: string
  scrollContainer?: React.RefObject<HTMLDivElement | null>
}

export function ChatMessage({ messages, streamMessage, scrollContainer }: ChatMessageProps) {
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex max-h-[400px] flex-col gap-2 overflow-y-auto p-4'>
        {messages.map((message,i ) => (
          <React.Fragment key={i}>
            {message.role === 'user' && (
              <div className='flex justify-end'>
                <div className='bg-secondary rounded-3xl rounded-tr-sm px-4 py-3 break-words whitespace-pre-wrap'>
                  {message.content}
                </div>
              </div>
            )}
            {message.role === 'assistant' && (
              <div className='flex justify-start'>
                <div className='bg-secondary rounded-3xl rounded-tl-sm px-4 py-3 break-words whitespace-pre-wrap'>
                  {message.content}
                </div>
              </div>
            )}
          </React.Fragment>
        ))}

        <Streamdown className='break-words whitespace-pre-wrap'>{streamMessage}</Streamdown>
        <div ref={scrollContainer}></div>
      </div>
    </div>
  )
}
