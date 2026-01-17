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
      <div className='flex  flex-col gap-2 overflow-y-auto p-4'>
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
              <Streamdown mode='static'>{message.content}</Streamdown>
            )}
          </React.Fragment>
        ))}

        <Streamdown mode='streaming'>{streamMessage}</Streamdown>
        <div ref={scrollContainer}></div>
      </div>
    </div>
  )
}
