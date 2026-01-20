'use client'

import React, { useState } from 'react'
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
  const [expandedStates, setExpandedStates] = useState<Record<number, boolean>>({})

  const toggleExpanded = (index: number) => {
    setExpandedStates((prev) => ({ ...prev, [index]: !prev[index] }))
  }

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
              <div className='bg-secondary rounded-3xl rounded px-4 py-3 break-words whitespace-pre-wrap'>
                <div className='flex items-center cursor-pointer' onClick={() => toggleExpanded(i)}>
                  <span className='bg-accent rounded-full px-3 py-1 text-sm mr-2 font-bold'>
                    {message.content.name}
                  </span>
                  <span className='text-xs'>{expandedStates[i] ? '▼' : '▶'}</span>
                </div>
                {expandedStates[i] && (
                  <div className='mt-1 ml-6'>
                    <div>
                      <span className='text-sm font-bold'>Input:</span>
                      <pre className='whitespace-pre-wrap text-xs'>
                        {JSON.stringify(JSON.parse(message.content.inputJSON), null, 2)}
                      </pre>
                    </div>
                    <div className='mt-2'>
                      <span className='text-sm font-bold'>Output:</span>
                      <pre className='whitespace-pre-wrap text-xs'>
                        {JSON.stringify(JSON.parse(message.content.outputJSON), null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
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
