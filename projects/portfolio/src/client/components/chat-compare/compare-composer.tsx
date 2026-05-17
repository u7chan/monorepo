import { type ChangeEvent, type KeyboardEvent, useCallback, useState } from 'react'
import { ArrowUpIcon } from '#/client/components/svg/arrow-up-icon'
import { StopIcon } from '#/client/components/svg/stop-icon'

interface CompareComposerProps {
  value: string
  disabled: boolean
  loading: boolean
  onChangeInput: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onChangeComposition: (composition: boolean) => void
  onCancel: () => void
  onSubmit: () => void
}

export function CompareComposer({
  value,
  disabled,
  loading,
  onChangeInput,
  onKeyDown,
  onChangeComposition,
  onCancel,
  onSubmit,
}: CompareComposerProps) {
  const [isComposing, setIsComposing] = useState(false)

  const handleCompositionStart = useCallback(() => {
    setIsComposing(true)
    onChangeComposition(true)
  }, [onChangeComposition])

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false)
    onChangeComposition(false)
  }, [onChangeComposition])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !isComposing && !loading && value.trim().length > 0) {
        event.preventDefault()
        onSubmit()
        return
      }
      onKeyDown(event)
    },
    [isComposing, loading, onSubmit, onKeyDown, value]
  )

  return (
    <div className='shrink-0 border-t border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800'>
      <div className='mx-auto flex max-w-(--breakpoint-lg) items-end gap-2'>
        <textarea
          value={value}
          onChange={onChangeInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          rows={2}
          placeholder={loading ? '応答を待っています...' : 'プロンプトを入力'}
          disabled={disabled}
          className='min-h-0 flex-1 resize-none overflow-y-auto rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-primary-700 focus:outline-none focus:ring-0.5 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-500'
        />
        {loading ? (
          <button
            type='button'
            onClick={onCancel}
            className='flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary-800 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-primary-700 dark:hover:bg-primary-600'
          >
            <StopIcon className='fill-white' size={18} />
          </button>
        ) : (
          <button
            type='button'
            onClick={onSubmit}
            disabled={disabled || value.trim().length === 0}
            className='flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary-800 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:cursor-default disabled:opacity-40 dark:bg-primary-700 dark:hover:bg-primary-600 dark:disabled:hover:bg-primary-700'
          >
            <ArrowUpIcon className='fill-white' size={22} />
          </button>
        )}
      </div>
    </div>
  )
}
