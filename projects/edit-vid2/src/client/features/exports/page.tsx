import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { type ExportJob } from '#/client/features/exports/job-card'
import type { Project } from '#/shared/schemas'

export function ExportsPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')

  const { data: jobs } = useQuery<ExportJob[]>({
    queryKey: ['export-jobs'],
    queryFn: () => fetch('/api/export-jobs?limit=100').then((r) => r.json()),
    refetchInterval: 3000,
  })

  const { data: projects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => fetch('/api/projects').then((r) => r.json()),
  })

  const cancelExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['export-jobs'] }),
  })

  const deleteExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['export-jobs'] }),
  })

  const filteredJobs = useMemo(() => {
    if (!jobs) return []
    return jobs.filter((job) => {
      if (statusFilter && job.status !== statusFilter) return false
      if (projectFilter && job.projectId !== projectFilter) return false
      return true
    })
  }, [jobs, statusFilter, projectFilter])

  const statusOptions = [
    { value: '', label: 'すべてのステータス' },
    { value: 'queued', label: '待機中' },
    { value: 'running', label: '実行中' },
    { value: 'succeeded', label: '完了' },
    { value: 'failed', label: '失敗' },
    { value: 'canceling', label: 'キャンセル中' },
    { value: 'canceled', label: 'キャンセル済' },
  ]

  return (
    <div className='flex h-full flex-col p-4 md:p-6'>
      <div className='mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <h1 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>書き出し履歴</h1>
        <div className='flex flex-col gap-2 sm:flex-row'>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className='rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
          >
            {statusOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className='rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
          >
            <option value=''>すべてのプロジェクト</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Desktop table */}
      <div className='hidden overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 md:block'>
        <table className='w-full text-left text-sm'>
          <thead className='bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400'>
            <tr>
              <th className='px-4 py-2'>ステータス</th>
              <th className='px-4 py-2'>プロジェクト</th>
              <th className='px-4 py-2'>進捗</th>
              <th className='px-4 py-2'>作成日時</th>
              <th className='px-4 py-2'>操作</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-gray-200 dark:divide-gray-700'>
            {filteredJobs.map((job) => (
              <tr key={job.id} className='bg-white dark:bg-gray-900'>
                <td className='px-4 py-2'>
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      {
                        queued: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
                        running: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
                        succeeded: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
                        failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
                        canceling: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
                        canceled: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
                      }[job.status] ?? ''
                    }`}
                  >
                    {
                      {
                        queued: '待機中',
                        running: '実行中',
                        succeeded: '完了',
                        failed: '失敗',
                        canceling: 'キャンセル中',
                        canceled: 'キャンセル済',
                      }[job.status] ?? job.status
                    }
                  </span>
                </td>
                <td className='px-4 py-2'>
                  <Link
                    to='/projects/$projectId'
                    params={{ projectId: job.projectId }}
                    className='text-indigo-600 hover:underline dark:text-indigo-400'
                  >
                    {job.projectName ?? ''}
                  </Link>
                </td>
                <td className='px-4 py-2'>
                  {job.status === 'running' || job.status === 'queued' ? (
                    <div className='w-32'>
                      <div className='h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700'>
                        <div
                          className='h-full rounded-full bg-indigo-600 transition-all duration-300'
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      <p className='mt-0.5 text-right text-xs text-gray-400'>{Math.round(job.progress)}%</p>
                    </div>
                  ) : (
                    <span className='text-gray-400'>-</span>
                  )}
                </td>
                <td className='px-4 py-2 text-gray-500 dark:text-gray-400'>
                  {new Date(job.createdAt).toLocaleString('ja-JP')}
                </td>
                <td className='px-4 py-2'>
                  <div className='flex gap-1'>
                    {(job.status === 'queued' || job.status === 'running') && (
                      <button
                        onClick={() => cancelExport.mutate(job.id)}
                        className='rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
                      >
                        キャンセル
                      </button>
                    )}
                    {job.status === 'succeeded' && job.outputPath && (
                      <a
                        href={`/api/export-jobs/${job.id}/download`}
                        className='rounded px-2 py-0.5 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900'
                      >
                        ダウンロード
                      </a>
                    )}
                    {(job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') && (
                      <button
                        onClick={() => {
                          if (confirm('この書き出し履歴と出力ファイルを削除しますか？'))
                            deleteExport.mutate(job.id)
                        }}
                        className='inline-flex h-6 w-6 items-center justify-center rounded text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
                        title='履歴と出力ファイルを削除'
                      >
                        <svg className='h-3.5 w-3.5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
                          <path strokeLinecap='round' strokeLinejoin='round' d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16' />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filteredJobs.length === 0 && (
              <tr>
                <td colSpan={5} className='px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500'>
                  書き出し履歴がありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className='space-y-3 md:hidden'>
        {filteredJobs.map((job) => (
          <div key={job.id} className='rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-600 dark:bg-gray-800'>
            <div className='mb-2 flex items-center justify-between'>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  {
                    queued: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
                    running: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
                    succeeded: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
                    failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
                    canceling: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
                    canceled: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
                  }[job.status] ?? ''
                }`}
              >
                {
                  {
                    queued: '待機中',
                    running: '実行中',
                    succeeded: '完了',
                    failed: '失敗',
                    canceling: 'キャンセル中',
                    canceled: 'キャンセル済',
                  }[job.status] ?? job.status
                }
              </span>
              <div className='flex gap-1'>
                {(job.status === 'queued' || job.status === 'running') && (
                  <button
                    onClick={() => cancelExport.mutate(job.id)}
                    className='rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
                  >
                    キャンセル
                  </button>
                )}
                {job.status === 'succeeded' && job.outputPath && (
                  <a
                    href={`/api/export-jobs/${job.id}/download`}
                    className='rounded px-2 py-0.5 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900'
                  >
                    ダウンロード
                  </a>
                )}
                {(job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') && (
                  <button
                    onClick={() => {
                      if (confirm('この書き出し履歴と出力ファイルを削除しますか？'))
                        deleteExport.mutate(job.id)
                    }}
                    className='inline-flex h-6 w-6 items-center justify-center rounded text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
                    title='履歴と出力ファイルを削除'
                  >
                    <svg className='h-3.5 w-3.5' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2}>
                      <path strokeLinecap='round' strokeLinejoin='round' d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16' />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <div className='mb-1 text-sm'>
              <span className='text-gray-500 dark:text-gray-400'>プロジェクト:</span>{' '}
              <Link
                to='/projects/$projectId'
                params={{ projectId: job.projectId }}
                className='text-indigo-600 hover:underline dark:text-indigo-400'
              >
                {job.projectName ?? ''}
              </Link>
            </div>
            <div className='mb-1 text-xs text-gray-400 dark:text-gray-500'>
              {new Date(job.createdAt).toLocaleString('ja-JP')}
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
                <p className='break-words'>
                  {job.errorMessage ?? '書き出しに失敗しました。ログを確認してください。'}
                </p>
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
        ))}
        {filteredJobs.length === 0 && (
          <p className='text-center text-sm text-gray-400 dark:text-gray-500'>書き出し履歴がありません</p>
        )}
      </div>
    </div>
  )
}
