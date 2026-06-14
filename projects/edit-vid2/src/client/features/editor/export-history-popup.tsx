import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { JobCard, type ExportJob } from '#/client/features/exports/job-card'

interface ExportHistoryPopupProps {
  projectId: string
  isOpen: boolean
  onClose: () => void
}

function invalidateExportJobs(queryClient: ReturnType<typeof useQueryClient>, projectId: string) {
  queryClient.invalidateQueries({ queryKey: ['export-jobs', projectId] })
  queryClient.invalidateQueries({ queryKey: ['export-jobs'] })
}

export function ExportHistoryPopup({ projectId, isOpen, onClose }: ExportHistoryPopupProps) {
  const queryClient = useQueryClient()

  const { data: jobs } = useQuery<ExportJob[]>({
    queryKey: ['export-jobs', projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/export-jobs`).then((r) => r.json()),
    refetchInterval: 3000,
    enabled: isOpen,
  })

  const cancelExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => invalidateExportJobs(queryClient, projectId),
  })

  const deleteExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => invalidateExportJobs(queryClient, projectId),
  })

  if (!isOpen) return null

  const recentJobs = jobs?.slice(0, 5) ?? []

  return (
    <>
      <div className='fixed inset-0 z-40' onClick={onClose} role='presentation' aria-hidden='true' />
      <div className='absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-gray-200 bg-white p-4 shadow-lg dark:border-gray-700 dark:bg-gray-800'>
        <div className='mb-3 flex items-center justify-between'>
          <h3 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>書き出し履歴</h3>
          <button
            type='button'
            onClick={onClose}
            className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
            aria-label='閉じる'
          >
            <X className='h-4 w-4' />
          </button>
        </div>

        <div className='max-h-80 space-y-3 overflow-y-auto'>
          {recentJobs.length === 0 && (
            <p className='text-center text-xs text-gray-400 dark:text-gray-500'>書き出し履歴がありません</p>
          )}
          {recentJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onCancel={() => cancelExport.mutate(job.id)}
              onDelete={() => deleteExport.mutate(job.id)}
            />
          ))}
        </div>

        <div className='mt-3 border-t border-gray-200 pt-2 dark:border-gray-700'>
          <Link
            to='/exports'
            onClick={onClose}
            className='text-xs text-indigo-600 hover:underline dark:text-indigo-400'
          >
            履歴をすべて見る
          </Link>
        </div>
      </div>
    </>
  )
}
