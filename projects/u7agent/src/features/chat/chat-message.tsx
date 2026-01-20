'use client'

import React from 'react'
import { Streamdown } from 'streamdown'
import { AgentMessage } from '@/features/agent/actions'

interface ChatMessageProps {
  messages: AgentMessage[]
  streamMessage: string
  scrollContainer?: React.RefObject<HTMLDivElement | null>
  scrollWrapper?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
}

export function ChatMessage({ messages, streamMessage, scrollContainer, scrollWrapper, onScroll }: ChatMessageProps) {
  return (
    <div className='h-full min-h-0 flex-1'>
      <div ref={scrollWrapper} onScroll={onScroll} className='flex h-full flex-col gap-2 overflow-y-auto p-4'>
        {messages.map((message, i) => (
          <React.Fragment key={i}>
            {message.role === 'user' && (
              <div className='flex justify-end'>
                <div className='bg-secondary rounded-3xl rounded-tr-sm px-4 py-3 break-words whitespace-pre-wrap'>
                  {message.content}
                </div>
              </div>
            )}
            {message.role === 'assistant' && <Streamdown mode='static'>{message.content}</Streamdown>}
            {message.role === 'tools' && (
              <div className='bg-secondary rounded-3xl rounded-tr-sm px-4 py-3 break-words whitespace-pre-wrap'>
                {message.content.name}
                <br />
                Input: {message.content.inputJSON}
                <br />
                Output: {message.content.outputJSON}
              </div>
            )}
          </React.Fragment>
        ))}

        <Streamdown mode='streaming'>{streamMessage}</Streamdown>
        <div ref={scrollContainer}></div>
      </div>
    </div>
  )
}
