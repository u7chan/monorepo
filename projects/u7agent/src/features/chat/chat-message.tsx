'use client'

import React from 'react'
import { Streamdown } from 'streamdown'

import { AgentMessage } from '@/features/agent/actions'
import { ToolApprovalMessage } from '@/features/chat/tool-approval-message'
import { ToolMessage } from '@/features/chat/tool-message'

interface ChatMessageProps {
  messages: AgentMessage[]
  streamMessage: string
  scrollContainer?: React.RefObject<HTMLDivElement | null>
  scrollWrapper?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
  onToolApproval?: (approvalId: string, approved: boolean) => void
}

export function ChatMessage({
  messages,
  streamMessage,
  scrollContainer,
  scrollWrapper,
  onScroll,
  onToolApproval,
}: ChatMessageProps) {
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
            {message.role === 'assistant' &&
              message.content.map((content, i) =>
                content.type === 'text' ? (
                  <React.Fragment key={i}>
                    <Streamdown mode='static'>{content.text}</Streamdown>
                  </React.Fragment>
                ) : null,
              )}
            {message.role === 'custom-tool-message' && <ToolMessage content={message.content} />}
            {message.role === 'custom-tool-approval-request' && i === messages.length - 1 && (
              <ToolApprovalMessage
                content={message.content}
                approvalId={message.approvalId}
                onApprove={(approvalId) => onToolApproval?.(approvalId, true)}
                onReject={(approvalId) => onToolApproval?.(approvalId, false)}
              />
            )}
          </React.Fragment>
        ))}
        {streamMessage && <Streamdown mode='streaming'>{streamMessage}</Streamdown>}
        <div ref={scrollContainer}></div>
      </div>
    </div>
  )
}
