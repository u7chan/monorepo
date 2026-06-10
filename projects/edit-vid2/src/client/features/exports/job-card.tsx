import { Trash2 } from 'lucide-react'

export interface ExportJob {
  id: string
  projectId: string
  projectName?: string
  status: string
  progress: number
  outputPath: string | null
  logPath: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export const statusLabels: Record<string, string> = {
  queued: '待機中',
  running: '実行中',
  succeeded: '完了',
  failed: '失敗',
  canceling: 'キャンセル中',
  canceled: 'キャンセル済',
}

export const statusColors: Record<string, string> = {
  queued: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  succeeded: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  canceling: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  canceled: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
}

interface JobCardProps {
  job: ExportJob
  onCancel: () => void
  onDelete: () => void
}

export function JobCard({ job, onCancel, onDelete }: JobCardProps) {
  const canCancel = job.status === 'queued' || job.status === 'running'
  const canDownload = job.status === 'succeeded' && job.outputPath
  const canDelete = job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled'

  return (
    <div className='rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-600 dark:bg-gray-800'>
      <div className='flex items-center justify-between'>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[job.status] ?? ''}`}>
          {statusLabels[job.status] ?? job.status}
        </span>
        <div className='flex gap-1'>
          {canCancel && (
            <button
              onClick={onCancel}
              className='rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
            >
              キャンセル
            </button>
          )}
          {canDownload && (
            <a
              href={`/api/export-jobs/${job.id}/download`}
              className='rounded px-2 py-0.5 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900'
            >
              ダウンロード
            </a>
          )}
          {canDelete && (
            <button
              onClick={() => {
                if (confirm('この書き出し履歴と出力ファイルを削除しますか？')) onDelete()
              }}
              className='inline-flex h-6 w-6 items-center justify-center rounded text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
              title='履歴と出力ファイルを削除'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      </div>
      {(job.status === 'running' || job.status === 'queued') && (
        <div className='mt-2'>
          <div className='h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700'>
            <div
              className='h-full rounded-full bg-indigo-600 transition-all duration-300'
              style={{ width: `${job.progress}%` }}
            />
          </div>
          <p className='mt-1 text-right text-xs text-gray-400'>{Math.round(job.progress)}%</p>
        </div>
      )}
      {job.status === 'failed' && (
        <div className='mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'>
          <p className='break-words'>{job.errorMessage ?? '書き出しに失敗しました。ログを確認してください。'}</p>
          {job.logPath && (
            <a
              href={`/${job.logPath}`}
              target='_blank'
              rel='noreferrer'
              className='mt-1 inline-block font-medium underline underline-offset-2'
            >
              ffmpegログを開く
            </a>
          )}
        </div>
      )}
    </div>
  )
}
