import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Clapperboard, Copy, Edit, FileVideo, Link2, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

interface Project {
  id: string
  videoAssetId: string
  name: string
  createdAt: string
  updatedAt: string
}

interface VideoAsset {
  id: string
  displayName: string
  status: string
  duration: number | null
  thumbnailPath: string | null
}

export function ProjectsPage() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [linkingProject, setLinkingProject] = useState<Project | null>(null)
  const [editName, setEditName] = useState('')

  const { data: projects, isLoading: projectsLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => fetch('/api/projects').then((r) => r.json()),
  })

  const { data: videos } = useQuery<VideoAsset[]>({
    queryKey: ['videos'],
    queryFn: () => fetch('/api/videos').then((r) => r.json()),
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string; videoAssetId: string }) =>
      fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowCreate(false)
    },
  })

  const duplicateMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) =>
      fetch(`/api/projects/${id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(name ? { name } : {}),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`/api/projects/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, name, videoAssetId }: { id: string; name?: string; videoAssetId?: string }) =>
      fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, videoAssetId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setEditingId(null)
      setLinkingProject(null)
    },
  })

  const readyVideos = videos?.filter((v) => v.status === 'ready') ?? []

  return (
    <div className='p-6'>
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='text-2xl font-bold text-gray-900 dark:text-gray-100'>プロジェクト</h1>
        <button
          onClick={() => setShowCreate(true)}
          className='inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700'
        >
          <Plus className='h-4 w-4' />
          新規プロジェクト
        </button>
      </div>

      {showCreate && (
        <CreateProjectModal
          videos={readyVideos}
          onSubmit={(name, videoAssetId) => createMutation.mutate({ name, videoAssetId })}
          onClose={() => setShowCreate(false)}
          loading={createMutation.isPending}
        />
      )}
      {linkingProject && (
        <LinkVideoModal
          project={linkingProject}
          videos={readyVideos}
          onSubmit={(videoAssetId) => updateMutation.mutate({ id: linkingProject.id, videoAssetId })}
          onClose={() => setLinkingProject(null)}
          loading={updateMutation.isPending}
        />
      )}

      {projectsLoading ? (
        <div className='flex items-center justify-center py-20'>
          <div className='h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent' />
        </div>
      ) : projects && projects.length > 0 ? (
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
          {projects.map((project) => {
            const video = videos?.find((v) => v.id === project.videoAssetId)
            const hasVideo = !!video
            return (
              <div
                key={project.id}
                className='group rounded-xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800'
              >
                <Link to='/projects/$projectId' params={{ projectId: project.id }}>
                  <div className='mb-3 aspect-video overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-700'>
                    {video?.thumbnailPath ? (
                      <img src={`/${video.thumbnailPath}`} alt={project.name} className='h-full w-full object-cover' />
                    ) : (
                      <div className='flex h-full flex-col items-center justify-center gap-2 px-3 text-center'>
                        <FileVideo className='h-12 w-12 text-gray-400' />
                        {!hasVideo && (
                          <span className='text-xs font-medium text-indigo-600 dark:text-indigo-300'>
                            元動画が見つかりません
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </Link>

                <div className='space-y-1'>
                  {editingId === project.id ? (
                    <div className='flex gap-1'>
                      <input
                        type='text'
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className='flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') updateMutation.mutate({ id: project.id, name: editName })
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                      />
                      <button
                        onClick={() => updateMutation.mutate({ id: project.id, name: editName })}
                        className='rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700'
                      >
                        保存
                      </button>
                    </div>
                  ) : (
                    <Link to='/projects/$projectId' params={{ projectId: project.id }}>
                      <h3 className='font-medium text-gray-900 truncate hover:text-indigo-600 dark:text-gray-100 dark:hover:text-indigo-400'>
                        {project.name}
                      </h3>
                    </Link>
                  )}

                  <p className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                    {video?.displayName ?? '動画未紐づけ'}
                  </p>
                  {!hasVideo && (
                    <button
                      type='button'
                      onClick={() => setLinkingProject(project)}
                      className='mt-2 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-indigo-300 px-2 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/60 dark:text-indigo-300 dark:hover:bg-indigo-500/10'
                    >
                      <Link2 className='h-3.5 w-3.5' />
                      動画を紐づけ
                    </button>
                  )}

                  <div className='flex items-center gap-1'>
                    <span className='text-xs text-gray-400 dark:text-gray-500'>
                      {new Date(project.updatedAt).toLocaleDateString('ja-JP')}
                    </span>
                    <div className='ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity'>
                      <button
                        onClick={() => {
                          setEditingId(project.id)
                          setEditName(project.name)
                        }}
                        className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
                      >
                        <Edit className='h-3.5 w-3.5' />
                      </button>
                      <button
                        onClick={() => duplicateMutation.mutate({ id: project.id })}
                        className='rounded p-1 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-900 dark:hover:text-indigo-400'
                      >
                        <Copy className='h-3.5 w-3.5' />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('このプロジェクトを削除しますか？')) deleteMutation.mutate(project.id)
                        }}
                        className='rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900 dark:hover:text-red-400'
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className='flex flex-col items-center justify-center py-20 text-center'>
          <Clapperboard className='mb-4 h-16 w-16 text-gray-300 dark:text-gray-600' />
          <p className='text-lg text-gray-500 dark:text-gray-400'>プロジェクトがありません</p>
          <p className='mt-1 text-sm text-gray-400 dark:text-gray-500'>
            「新規プロジェクト」ボタンからプロジェクトを作成してください
          </p>
        </div>
      )}
    </div>
  )
}

function LinkVideoModal({
  project,
  videos,
  onSubmit,
  onClose,
  loading,
}: {
  project: Project
  videos: VideoAsset[]
  onSubmit: (videoAssetId: string) => void
  onClose: () => void
  loading: boolean
}) {
  const [selectedVideoId, setSelectedVideoId] = useState(videos[0]?.id ?? '')

  useEffect(() => {
    if (!selectedVideoId && videos[0]) {
      setSelectedVideoId(videos[0].id)
    }
  }, [selectedVideoId, videos])

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={onClose}>
      <div
        className='w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800'
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className='mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100'>動画を紐づけ</h2>
        <p className='mb-4 truncate text-sm text-gray-500 dark:text-gray-400'>{project.name}</p>
        <label className='mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300'>元動画</label>
        <select
          value={selectedVideoId}
          onChange={(e) => setSelectedVideoId(e.target.value)}
          className='w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
        >
          {videos.length === 0 && <option value=''>利用可能な動画がありません</option>}
          {videos.map((v) => (
            <option key={v.id} value={v.id}>
              {v.displayName}
            </option>
          ))}
        </select>
        <div className='mt-6 flex justify-end gap-2'>
          <button
            onClick={onClose}
            className='rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
          >
            キャンセル
          </button>
          <button
            onClick={() => onSubmit(selectedVideoId)}
            disabled={loading || !selectedVideoId}
            className='inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50'
          >
            <Link2 className='h-4 w-4' />
            {loading ? '保存中...' : '紐づけ'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CreateProjectModal({
  videos,
  onSubmit,
  onClose,
  loading,
}: {
  videos: VideoAsset[]
  onSubmit: (name: string, videoAssetId: string) => void
  onClose: () => void
  loading: boolean
}) {
  const [name, setName] = useState('')
  const [selectedVideoId, setSelectedVideoId] = useState(videos[0]?.id ?? '')

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={onClose}>
      <div
        className='w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800'
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className='mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100'>新規プロジェクト</h2>
        <div className='space-y-4'>
          <div>
            <label className='mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300'>プロジェクト名</label>
            <input
              type='text'
              value={name}
              onChange={(e) => setName(e.target.value)}
              className='w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
              placeholder='プロジェクト名を入力'
              autoFocus
            />
          </div>
          <div>
            <label className='mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300'>元動画</label>
            <select
              value={selectedVideoId}
              onChange={(e) => setSelectedVideoId(e.target.value)}
              className='w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
            >
              {videos.length === 0 && <option value=''>利用可能な動画がありません</option>}
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className='mt-6 flex justify-end gap-2'>
          <button
            onClick={onClose}
            className='rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
          >
            キャンセル
          </button>
          <button
            onClick={() => onSubmit(name || '無題のプロジェクト', selectedVideoId)}
            disabled={loading || !selectedVideoId}
            className='rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50'
          >
            {loading ? '作成中...' : '作成'}
          </button>
        </div>
      </div>
    </div>
  )
}
