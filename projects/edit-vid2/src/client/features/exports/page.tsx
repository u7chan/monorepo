import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Download, Play, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { JobCard, statusColors, statusLabels, type ExportJob } from '#/client/features/exports/job-card'
import type { Project } from '#/shared/schemas'

function JobStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[status] ?? ''}`}>
      {statusLabels[status] ?? status}
    </span>
  )
}

function JobActions({
  job,
  onCancel,
  onDelete,
  onPreview,
}: {
  job: ExportJob
  onCancel: () => void
  onDelete: () => void
  onPreview: () => void
}) {
  const canCancel = job.status === 'queued' || job.status === 'running'
  const canDownload = job.status === 'succeeded' && job.outputPath
  const canPreview = canDownload
  const canDelete = job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled'

  return (
    <div className='flex gap-1'>
      {canCancel && (
        <button
          onClick={onCancel}
          className='rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
        >
          キャンセル
        </button>
      )}
      {canPreview && (
        <button
          onClick={onPreview}
          className='inline-flex h-6 w-6 items-center justify-center rounded text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900'
          title='プレビュー'
          aria-label='プレビュー'
        >
          <Play className='h-3.5 w-3.5' />
        </button>
      )}
      {canDownload && (
        <a
          href={`/api/export-jobs/${job.id}/download`}
          className='inline-flex h-6 w-6 items-center justify-center rounded text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900'
          title='ダウンロード'
          aria-label='ダウンロード'
        >
          <Download className='h-3.5 w-3.5' />
        </a>
      )}
      {canDelete && (
        <button
          onClick={() => {
            if (confirm('この書き出し履歴と出力ファイルを削除しますか？')) onDelete()
          }}
          className='inline-flex h-6 w-6 items-center justify-center rounded text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900'
          title='履歴と出力ファイルを削除'
          aria-label='履歴と出力ファイルを削除'
        >
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  )
}

function JobProgress({ progress }: { progress: number }) {
  return (
    <div className='w-32'>
      <div className='h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700'>
        <div
          className='h-full rounded-full bg-indigo-600 transition-all duration-300'
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className='mt-0.5 text-right text-xs text-gray-400'>{Math.round(progress)}%</p>
    </div>
  )
}

type ExportPreviewTarget = {
  id: string
  projectName?: string
  createdAt: string
}

function ExportPreviewModal({ target, onClose }: { target: ExportPreviewTarget; onClose: () => void }) {
  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/80'
      onClick={onClose}
      role='presentation'
    >
      <div className='relative w-full max-w-4xl px-4' onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className='absolute -top-10 right-0 rounded-full p-1 text-white/70 hover:text-white'
          aria-label='閉じる'
        >
          <X className='h-6 w-6' />
        </button>
        <video
          src={`/api/export-jobs/${target.id}/preview`}
          controls
          autoPlay
          className='w-full max-h-[80vh] rounded-lg bg-black'
        />
        <p className='mt-2 text-center text-sm text-white/70'>
          {target.projectName ?? ''} · {new Date(target.createdAt).toLocaleString('ja-JP')}
        </p>
      </div>
    </div>
  )
}

export function ExportsPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [previewTarget, setPreviewTarget] = useState<ExportPreviewTarget | null>(null)

  const { data: jobs } = useQuery<ExportJob[]>({
    queryKey: ['export-jobs'],
    queryFn: async () => {
      const r = await fetch('/api/export-jobs?limit=100')
      if (!r.ok) throw new Error(`Failed to fetch export jobs: ${r.status}`)
      return r.json()
    },
    refetchInterval: 3000,
  })

  const { data: projects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const r = await fetch('/api/projects')
      if (!r.ok) throw new Error(`Failed to fetch projects: ${r.status}`)
      return r.json()
    },
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

  const statusOptions = useMemo(
    () => [
      { value: '', label: 'すべてのステータス' },
      ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
    ],
    []
  )

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
                  <JobStatusBadge status={job.status} />
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
                    <JobProgress progress={job.progress} />
                  ) : (
                    <span className='text-gray-400'>-</span>
                  )}
                </td>
                <td className='px-4 py-2 text-gray-500 dark:text-gray-400'>
                  {new Date(job.createdAt).toLocaleString('ja-JP')}
                </td>
                <td className='px-4 py-2'>
                  <JobActions
                    job={job}
                    onCancel={() => cancelExport.mutate(job.id)}
                    onDelete={() => deleteExport.mutate(job.id)}
                    onPreview={() =>
                      setPreviewTarget({
                        id: job.id,
                        projectName: job.projectName,
                        createdAt: job.createdAt,
                      })
                    }
                  />
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
          <div key={job.id}>
            <JobCard
              job={job}
              onCancel={() => cancelExport.mutate(job.id)}
              onDelete={() => deleteExport.mutate(job.id)}
              onPreview={() =>
                setPreviewTarget({
                  id: job.id,
                  projectName: job.projectName,
                  createdAt: job.createdAt,
                })
              }
            />
            <div className='mt-1 px-1 text-sm'>
              <span className='text-gray-500 dark:text-gray-400'>プロジェクト:</span>{' '}
              <Link
                to='/projects/$projectId'
                params={{ projectId: job.projectId }}
                className='text-indigo-600 hover:underline dark:text-indigo-400'
              >
                {job.projectName ?? ''}
              </Link>
            </div>
            <div className='px-1 text-xs text-gray-400 dark:text-gray-500'>
              {new Date(job.createdAt).toLocaleString('ja-JP')}
            </div>
          </div>
        ))}
        {filteredJobs.length === 0 && (
          <p className='text-center text-sm text-gray-400 dark:text-gray-500'>書き出し履歴がありません</p>
        )}
      </div>
      {previewTarget && <ExportPreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />}
    </div>
  )
}
