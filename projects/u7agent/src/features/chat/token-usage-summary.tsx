'use client'

import { TokenUsage } from '@/features/agent-service/agent-stream-service'

interface TokenUsageSummaryProps {
  tokenUsage?: TokenUsage
  finishReason?: string
  processingTimeMs?: number
}

export function TokenUsageSummary({ tokenUsage, finishReason, processingTimeMs }: TokenUsageSummaryProps) {
  const hasTokenUsage = Boolean(tokenUsage)
  const totalInputTokens = hasTokenUsage
    ? (tokenUsage?.input.noCache ?? 0) + (tokenUsage?.input.cacheRead ?? 0) + (tokenUsage?.input.cacheWrite ?? 0)
    : undefined
  const totalOutputTokens = hasTokenUsage
    ? (tokenUsage?.output.text ?? 0) + (tokenUsage?.output.reasoning ?? 0)
    : undefined
  const inputBreakdown = hasTokenUsage
    ? [
        ['No cache', tokenUsage?.input.noCache],
        ['Cache read', tokenUsage?.input.cacheRead],
        ['Cache write', tokenUsage?.input.cacheWrite],
      ]
    : []
  const outputBreakdown = hasTokenUsage
    ? [
        ['Text', tokenUsage?.output.text],
        ['Reasoning', tokenUsage?.output.reasoning],
      ]
    : []

  return (
    <div className='border-t border-slate-200/60 px-4 py-2 text-[11px] text-slate-500'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='min-w-0 flex-1'>
          <div className='group relative inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600'>
            <span>Input {totalInputTokens ?? '—'}</span>
            <span className='text-slate-400'>/</span>
            <span>Output {totalOutputTokens ?? '—'}</span>
            {hasTokenUsage && (
              <div className='pointer-events-none absolute bottom-full left-0 z-10 mb-2 hidden min-w-[200px] flex-col gap-1 rounded border border-slate-200 bg-white p-3 text-[10px] text-slate-500 shadow-md group-hover:flex dark:border-slate-700 dark:bg-slate-900'>
                <div className='text-[11px] font-semibold text-slate-700 dark:text-slate-200'>Input</div>
                {inputBreakdown.map(([label, value]) => (
                  <div key={label} className='flex items-center justify-between text-[10px]'>
                    <span className='text-slate-500 capitalize'>{label}</span>
                    <span className='font-mono text-slate-700 dark:text-slate-200'>{value ?? 0}</span>
                  </div>
                ))}
                <div className='mt-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200'>Output</div>
                {outputBreakdown.map(([label, value]) => (
                  <div key={label} className='flex items-center justify-between text-[10px]'>
                    <span className='text-slate-500 capitalize'>{label}</span>
                    <span className='font-mono text-slate-700 dark:text-slate-200'>{value ?? 0}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className='flex flex-wrap gap-4 text-[11px] text-slate-500'>
          <span>Finish reason {finishReason ?? '—'}</span>
          <span>
            Processing time {processingTimeMs !== undefined ? `${(processingTimeMs / 1000).toFixed(2)} s` : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}
