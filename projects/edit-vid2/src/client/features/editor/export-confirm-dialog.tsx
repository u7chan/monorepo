import { Download, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { ExportPresetForm } from '#/client/features/editor/export-preset-form'
import type { ExportPreset } from '#/shared/schemas'

interface ExportConfirmDialogProps {
  isOpen: boolean
  preset: ExportPreset
  duration: number
  trimDuration: number
  hasSubtitles: boolean
  isPending: boolean
  onPresetChange: (preset: ExportPreset) => void
  onExport: () => void
  onClose: () => void
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export function ExportConfirmDialog({
  isOpen,
  preset,
  duration,
  trimDuration,
  hasSubtitles,
  isPending,
  onPresetChange,
  onExport,
  onClose,
}: ExportConfirmDialogProps) {
  if (!isOpen) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'
      onClick={onClose}
      role='presentation'
    >
      <div
        className='w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800'
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role='dialog'
        aria-modal='true'
        aria-label='書き出し確認'
        tabIndex={-1}
      >
        <div className='mb-4 flex items-center justify-between'>
          <h2 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>書き出しの確認</h2>
          <button
            type='button'
            onClick={onClose}
            className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
            aria-label='閉じる'
          >
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='space-y-4'>
          <section>
            <h3 className='mb-2 text-sm font-medium text-gray-700 dark:text-gray-300'>書き出し設定</h3>
            <div className='rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-700/50'>
              <ExportPresetForm preset={preset} onChange={onPresetChange} />
            </div>
          </section>

          <section>
            <h3 className='mb-2 text-sm font-medium text-gray-700 dark:text-gray-300'>出力情報</h3>
            <dl className='space-y-1 text-sm'>
              <div className='flex justify-between'>
                <dt className='text-gray-500 dark:text-gray-400'>元動画の長さ</dt>
                <dd className='text-gray-900 dark:text-gray-100'>{formatSeconds(duration)}</dd>
              </div>
              <div className='flex justify-between'>
                <dt className='text-gray-500 dark:text-gray-400'>切り抜き後の予想時間</dt>
                <dd className='text-gray-900 dark:text-gray-100'>{formatSeconds(trimDuration)}</dd>
              </div>
              <div className='flex justify-between'>
                <dt className='text-gray-500 dark:text-gray-400'>字幕</dt>
                <dd className='text-gray-900 dark:text-gray-100'>{hasSubtitles ? '有り' : '無し'}</dd>
              </div>
            </dl>
          </section>
        </div>

        <div className='mt-6 flex justify-end gap-2'>
          <button
            type='button'
            onClick={onClose}
            disabled={isPending}
            className='rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
          >
            キャンセル
          </button>
          <button
            type='button'
            onClick={onExport}
            disabled={isPending}
            className='inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50'
          >
            <Download className='h-4 w-4' />
            {isPending ? '作成中...' : '最終書き出し'}
          </button>
        </div>
      </div>
    </div>
  )
}
