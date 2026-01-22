'use client'

import { useState } from 'react'

import type { ToolCallPayload } from '@/features/agent-service/agent-stream-service'

interface ToolMessageProps {
  content: ToolCallPayload
}

export function ToolMessage({ content }: ToolMessageProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className='rounded-[2rem] border border-slate-200/30 bg-gradient-to-br from-white/80 via-slate-50/70 to-slate-100 p-1 dark:border-slate-600/40 dark:from-slate-900/70 dark:via-slate-900/60 dark:to-slate-950/80'>
      <div className='bg-white dark:bg-slate-900 rounded-[1.8rem] px-4 py-3 text-slate-900 dark:text-white break-words whitespace-pre-wrap'>
        <button
          type='button'
          className='flex items-center w-full cursor-pointer text-left transition-colors hover:text-accent focus-visible:outline-none'
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span className='bg-accent/70 text-slate-900 rounded-full px-3 py-[0.15rem] text-xs font-semibold mr-3 dark:text-white'>
            {content.name}
          </span>
          <span className='text-xs transition-transform duration-150' aria-label='expand'>
            {expanded ? '▼' : '▶'}
          </span>
        </button>
        {expanded && (
          <div className='mt-3 ml-7 space-y-3 text-xs leading-relaxed text-slate-600 dark:text-slate-100'>
            <div className='space-y-1'>
              <span className='text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300'>
                Input
              </span>
              <pre className='rounded-xl border border-slate-200/60 bg-slate-50/80 p-3 text-[11px] font-mono text-slate-800 dark:border-slate-700/60 dark:bg-slate-900/50 dark:text-slate-200 overflow-x-auto'>
                {JSON.stringify(JSON.parse(content.inputJSON), null, 2)}
              </pre>
            </div>
            <div className='space-y-1'>
              <span className='text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300'>
                Output
              </span>
              <pre className='rounded-xl border border-slate-200/60 bg-slate-50/80 p-3 text-[11px] font-mono text-slate-800 dark:border-slate-700/60 dark:bg-slate-900/50 dark:text-slate-200 overflow-x-auto'>
                {JSON.stringify(JSON.parse(content.outputJSON), null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
