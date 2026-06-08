import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Clapperboard, Download, FileVideo, LoaderCircle, Pencil, Play, Trash2, Upload, X } from 'lucide-react'
import { useState, useEffect } from 'react'

interface VideoAsset {
  id: string
  originalFilename: string
  displayName: string
  storagePath: string
  thumbnailPath: string | null
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  codec: string | null
  hasAudio: boolean | null
  fileSize: number | null
  status: string
  createdAt: string
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return '--'
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function downloadName(displayName: string, originalFilename: string): string {
  const ext = originalFilename.match(/\.[^.]+$/)?.[0] ?? ''
  if (!ext) return displayName
  return displayName.endsWith(ext) ? displayName : `${displayName}${ext}`
}

function isPendingVideo(video: VideoAsset): boolean {
  return video.status === 'uploading' || video.status === 'processing'
}

export function VideosPage() {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [previewVideo, setPreviewVideo] = useState<VideoAsset | null>(null)

  const { data: videos, isLoading } = useQuery<VideoAsset[]>({
    queryKey: ['videos'],
    queryFn: () => fetch('/api/videos').then((r) => r.json()),
    refetchInterval: (query) => (query.state.data?.some(isPendingVideo) ? 3000 : false),
    refetchIntervalInBackground: true,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`/api/videos/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['videos'] }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, displayName }: { id: string; displayName: string }) =>
      fetch(`/api/videos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['videos'] })
      setEditingId(null)
    },
  })

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/videos', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'upload failed')
      }
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['videos'] }),
  })

  return (
    <div className='p-6'>
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='text-2xl font-bold text-gray-900 dark:text-gray-100'>動画ライブラリ</h1>
        <label className='inline-flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700'>
          <Upload className='h-4 w-4' />
          アップロード
          <input
            type='file'
            accept='video/mp4,video/quicktime,video/webm,video/x-matroska'
            className='hidden'
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) uploadMutation.mutate(file)
              e.target.value = ''
            }}
          />
        </label>
      </div>

      {uploadMutation.isError && (
        <div className='mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700'>
          {uploadMutation.error?.message}
        </div>
      )}

      {isLoading ? (
        <div className='flex items-center justify-center py-20'>
          <div className='h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent' />
        </div>
      ) : videos && videos.length > 0 ? (
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
          {videos.map((video) => {
            const isPending = isPendingVideo(video)
            const isReady = video.status === 'ready'

            return (
              <div
                key={video.id}
                className='group rounded-xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800'
              >
                <button
                  type='button'
                  onClick={() => {
                    if (!isPending) setPreviewVideo(video)
                  }}
                  disabled={isPending}
                  className={`group/thumb relative mb-3 aspect-video w-full overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-700 ${
                    isPending ? 'cursor-wait' : ''
                  }`}
                >
                  {video.thumbnailPath ? (
                    <img
                      src={`/${video.thumbnailPath}`}
                      alt={video.displayName}
                      className='h-full w-full object-cover'
                    />
                  ) : (
                    <div className='flex h-full items-center justify-center'>
                      <FileVideo className='h-12 w-12 text-gray-400' />
                    </div>
                  )}
                  {isPending ? (
                    <div className='absolute inset-0 flex items-center justify-center bg-black/20'>
                      <LoaderCircle className='h-10 w-10 animate-spin text-white drop-shadow-lg' />
                    </div>
                  ) : (
                    <div className='absolute inset-0 flex items-center justify-center transition-colors group-hover/thumb:bg-black/30'>
                      <Play className='h-12 w-12 text-white opacity-0 transition-opacity group-hover/thumb:opacity-90 drop-shadow-lg' />
                    </div>
                  )}
                </button>

                <div className='space-y-1'>
                  {editingId === video.id ? (
                    <div className='flex gap-1'>
                      <input
                        type='text'
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className='flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') updateMutation.mutate({ id: video.id, displayName: editName })
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                      />
                      <button
                        onClick={() => updateMutation.mutate({ id: video.id, displayName: editName })}
                        className='rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700'
                      >
                        保存
                      </button>
                    </div>
                  ) : (
                    <h3 className='font-medium text-gray-900 truncate dark:text-gray-100'>{video.displayName}</h3>
                  )}

                  <div className='flex flex-wrap gap-x-3 text-xs text-gray-500 dark:text-gray-400'>
                    <span>{formatDuration(video.duration)}</span>
                    {video.width && video.height && (
                      <span>
                        {video.width}x{video.height}
                      </span>
                    )}
                    <span>{formatFileSize(video.fileSize)}</span>
                    <span>{video.fps ? `${Math.round(video.fps)}fps` : ''}</span>
                  </div>

                  <div className='flex items-center gap-2'>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        video.status === 'ready'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                          : video.status === 'processing'
                            ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                            : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                      }`}
                    >
                      {video.status === 'ready' ? '完了' : video.status === 'processing' ? '処理中' : '失敗'}
                    </span>

                    <div className='ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity'>
                      <button
                        onClick={() => {
                          setEditingId(video.id)
                          setEditName(video.displayName)
                        }}
                        className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
                      >
                        <Pencil className='h-3.5 w-3.5' />
                      </button>
                      {isReady ? (
                        <a
                          href={`/${video.storagePath}`}
                          download={downloadName(video.displayName, video.originalFilename)}
                          className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
                        >
                          <Download className='h-3.5 w-3.5' />
                        </a>
                      ) : (
                        <button
                          type='button'
                          disabled
                          className='cursor-not-allowed rounded p-1 text-gray-400 opacity-40'
                          title='処理完了後にダウンロードできます'
                        >
                          <Download className='h-3.5 w-3.5' />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (confirm('この動画を削除しますか？')) deleteMutation.mutate(video.id)
                        }}
                        className='rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900 dark:hover:text-red-400'
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </button>
                      {isReady ? (
                        <Link
                          to='/projects'
                          className='rounded p-1 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-900 dark:hover:text-indigo-400'
                          title='プロジェクトを作成'
                        >
                          <Clapperboard className='h-3.5 w-3.5' />
                        </Link>
                      ) : (
                        <button
                          type='button'
                          disabled
                          className='cursor-not-allowed rounded p-1 text-gray-400 opacity-40'
                          title='処理完了後にプロジェクトを作成できます'
                        >
                          <Clapperboard className='h-3.5 w-3.5' />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className='flex flex-col items-center justify-center py-20 text-center'>
          <FileVideo className='mb-4 h-16 w-16 text-gray-300 dark:text-gray-600' />
          <p className='text-lg text-gray-500 dark:text-gray-400'>動画がありません</p>
          <p className='mt-1 text-sm text-gray-400 dark:text-gray-500'>アップロードボタンから動画を追加してください</p>
        </div>
      )}
      {previewVideo && <VideoPreviewModal video={previewVideo} onClose={() => setPreviewVideo(null)} />}
    </div>
  )
}

function VideoPreviewModal({ video, onClose }: { video: VideoAsset; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/80' onClick={onClose}>
      <div className='relative w-full max-w-4xl' onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className='absolute -top-10 right-0 rounded-full p-1 text-white/70 hover:text-white'>
          <X className='h-6 w-6' />
        </button>
        <video src={`/${video.storagePath}`} controls autoPlay className='w-full max-h-[80vh] rounded-lg bg-black' />
        <p className='mt-2 text-center text-sm text-white/70'>{video.displayName}</p>
      </div>
    </div>
  )
}
