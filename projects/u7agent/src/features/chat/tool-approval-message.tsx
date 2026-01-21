'use client'

import type { ToolCallPayload } from '@/features/agent/actions'

interface ToolApprovalMessageProps {
  content: ToolCallPayload
}

const formatPayload = (payload: string) => {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    return payload
  }
}

export function ToolApprovalMessage({ content }: ToolApprovalMessageProps) {
  const preview = formatPayload(content.inputJSON)

  return (
    <div className='rounded-[2rem] border border-amber-200/70 bg-gradient-to-br from-amber-50/90 via-white/60 to-white/80 p-1 dark:border-amber-500/60 dark:from-slate-900/80 dark:via-slate-900/60 dark:to-slate-950/80'>
      <div className='rounded-[1.7rem] bg-white/90 px-5 py-4 text-slate-900 shadow-sm dark:bg-slate-900/80 dark:text-white'>
        <div className='flex items-center justify-between'>
          <span className='text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-300'>Tool Run Confirmation</span>
          <span className='text-[11px] text-slate-400 dark:text-slate-500'>Awaiting approval</span>
        </div>
        <p className='mt-2 text-sm font-semibold text-slate-900 dark:text-white'>{content.name} execution is proposed</p>
        <p className='mt-1 text-[13px] text-slate-500 dark:text-slate-300'>Review the request before approving or rejecting.</p>
        <div className='mt-3 rounded-xl border border-amber-200/60 bg-amber-50/80 px-3 py-2 text-[11px] font-mono text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-100'>
          <pre className='max-h-28 overflow-auto whitespace-pre-wrap'>{preview}</pre>
        </div>
        <div className='mt-3 flex flex-wrap gap-2 text-[12px]'>
          <button
            type='button'
            className='flex-1 rounded-2xl border border-amber-500/70 bg-amber-500/80 px-4 py-2 font-semibold text-amber-950 transition hover:bg-amber-600 focus-visible:outline-none'
          >
            Approve
          </button>
          <button
            type='button'
            className='flex-1 rounded-2xl border border-slate-200/80 bg-white px-4 py-2 font-semibold text-slate-600 transition hover:border-slate-300 focus-visible:outline-none dark:border-slate-700/80 dark:bg-slate-900/70 dark:text-slate-200'
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}
