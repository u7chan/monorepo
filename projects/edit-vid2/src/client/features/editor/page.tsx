import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Download, FileVideo, Link2, RotateCcw, Trash2, Type, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { uuidv7 } from 'uuidv7'
import type {
  KeepSegment,
  Project,
  SubtitleItem,
  SubtitleTemplate,
  TimelineStateV1,
  VideoAsset,
} from '#/shared/schemas'

export function EditorPage() {
  const params = useParams({ from: '/projects/$projectId' })
  const projectId = params.projectId
  const queryClient = useQueryClient()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [showLinkVideo, setShowLinkVideo] = useState(false)

  const { data: project } = useQuery<Project>({
    queryKey: ['project', projectId],
    queryFn: () => fetch(`/api/projects/${projectId}`).then((r) => r.json()),
  })

  const { data: videoAsset } = useQuery<VideoAsset | null>({
    queryKey: ['video', project?.videoAssetId],
    enabled: !!project?.videoAssetId,
    queryFn: async () => {
      const res = await fetch(`/api/videos/${project!.videoAssetId}`)
      if (!res.ok) return null
      return res.json()
    },
  })

  const { data: videos } = useQuery<VideoAsset[]>({
    queryKey: ['videos'],
    queryFn: () => fetch('/api/videos').then((r) => r.json()),
  })

  const { data: templates } = useQuery<SubtitleTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => fetch('/api/templates').then((r) => r.json()),
  })

  const timelineState = (project?.timelineState as TimelineStateV1 | null) ?? {
    version: 1,
    tracks: [],
    keepSegments: [],
  }
  const mediaDuration = duration || videoAsset?.duration || 0
  const hasVideo = !!videoAsset?.storagePath
  const readyVideos = videos?.filter((video) => video.status === 'ready') ?? []

  const updateProject = useMutation({
    mutationFn: (data: { timelineState: TimelineStateV1 }) =>
      fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const saveTimelineState = useCallback(
    (newState: TimelineStateV1) => {
      updateProject.mutate({ timelineState: newState })
    },
    [updateProject]
  )

  const linkVideo = useMutation({
    mutationFn: (videoAssetId: string) =>
      fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoAssetId }),
      }),
    onSuccess: () => {
      setCurrentTime(0)
      setDuration(0)
      setShowLinkVideo(false)
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  useEffect(() => {
    setCurrentTime(0)
    setDuration(0)
  }, [videoAsset?.id])

  const addSubtitle = () => {
    if (!hasVideo) return
    const subTrack = timelineState.tracks.find((t) => t.type === 'subtitle')
    const newItem: SubtitleItem = {
      id: uuidv7(),
      sourceStart: currentTime,
      sourceEnd: Math.min(currentTime + 3, mediaDuration),
      text: '',
      templateId: templates?.[0]?.id ?? 'default',
      styleOverrides: {},
    }
    const updatedTracks = subTrack
      ? timelineState.tracks.map((t) => (t.type === 'subtitle' ? { ...t, items: [...t.items, newItem] } : t))
      : [...timelineState.tracks, { id: uuidv7(), type: 'subtitle' as const, items: [newItem] }]
    saveTimelineState({ ...timelineState, tracks: updatedTracks })
  }

  const subItems: SubtitleItem[] = timelineState.tracks.find((t) => t.type === 'subtitle')?.items ?? []

  return (
    <div className='flex h-full flex-col'>
      <div className='flex items-center gap-4 border-b border-gray-200 px-4 py-3 dark:border-gray-700'>
        <Link
          to='/projects'
          className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
        >
          <ArrowLeft className='h-5 w-5' />
        </Link>
        <h1 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>{project?.name ?? 'エディタ'}</h1>
        <span className='text-sm text-gray-400'>{videoAsset?.displayName ?? '動画未紐づけ'}</span>
        <div className='ml-auto flex gap-2'>
          {hasVideo && (
            <button
              type='button'
              onClick={() => setShowLinkVideo(true)}
              className='inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
            >
              <Link2 className='h-4 w-4' />
              動画を変更
            </button>
          )}
          <button
            onClick={addSubtitle}
            disabled={!hasVideo}
            className='inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50'
          >
            <Type className='h-4 w-4' />
            字幕追加 (A)
          </button>
        </div>
      </div>

      {showLinkVideo && (
        <EditorLinkVideoModal
          currentVideo={videoAsset}
          videos={readyVideos}
          loading={linkVideo.isPending}
          onSubmit={(videoAssetId) => linkVideo.mutate(videoAssetId)}
          onClose={() => setShowLinkVideo(false)}
        />
      )}

      <div className='flex flex-1 flex-col overflow-auto lg:flex-row'>
        <div className='flex-1 bg-black p-4'>
          {hasVideo ? (
            <video
              ref={videoRef}
              src={`/${videoAsset.storagePath}`}
              controls
              onTimeUpdate={(e) => {
                if (e.currentTarget.paused) return
                setCurrentTime(e.currentTarget.currentTime)
              }}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              className='max-h-[60vh] w-full rounded-lg'
            />
          ) : (
            <MissingVideoPlaceholder
              videos={readyVideos}
              loading={linkVideo.isPending}
              onSubmit={(videoAssetId) => linkVideo.mutate(videoAssetId)}
            />
          )}
        </div>

        <div className='w-full overflow-auto border-t border-gray-200 p-4 dark:border-gray-700 lg:w-96 lg:border-l lg:border-t-0'>
          <TrimPanel
            duration={mediaDuration}
            currentTime={currentTime}
            keepSegments={timelineState.keepSegments}
            onChange={(keepSegments) => saveTimelineState({ ...timelineState, keepSegments })}
          />

          <h2 className='mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300'>字幕 ({subItems.length})</h2>
          <div className='space-y-2'>
            {subItems.map((sub) => (
              <SubtitleEditorItem
                key={sub.id}
                item={sub}
                templates={templates ?? []}
                duration={mediaDuration}
                onChange={(updated) => {
                  const newItems = subItems.map((s) => (s.id === updated.id ? updated : s))
                  const newTracks = timelineState.tracks.map((t) =>
                    t.type === 'subtitle' ? { ...t, items: newItems } : t
                  )
                  saveTimelineState({ ...timelineState, tracks: newTracks })
                }}
                onDelete={() => {
                  const newItems = subItems.filter((s) => s.id !== sub.id)
                  const newTracks = timelineState.tracks.map((t) =>
                    t.type === 'subtitle' ? { ...t, items: newItems } : t
                  )
                  saveTimelineState({ ...timelineState, tracks: newTracks })
                }}
              />
            ))}
            {subItems.length === 0 && (
              <p className='text-xs text-gray-400 dark:text-gray-500'>
                字幕がありません。「字幕追加」ボタンまたは A キーで追加できます。
              </p>
            )}
          </div>

          <ExportPanel projectId={projectId} canExport={hasVideo} />
        </div>
      </div>

      <TimelineBar
        duration={mediaDuration}
        currentTime={currentTime}
        keepSegments={timelineState.keepSegments}
        subtitleItems={subItems}
        onSeek={(t) => {
          if (videoRef.current) {
            videoRef.current.currentTime = t
            setCurrentTime(t)
          }
        }}
      />
    </div>
  )
}

function MissingVideoPlaceholder({
  videos,
  loading,
  onSubmit,
}: {
  videos: VideoAsset[]
  loading: boolean
  onSubmit: (videoAssetId: string) => void
}) {
  const [selectedVideoId, setSelectedVideoId] = useState(videos[0]?.id ?? '')
  const resolvedSelectedVideoId = selectedVideoId || videos[0]?.id || ''

  return (
    <div className='flex min-h-[360px] w-full items-center justify-center rounded-lg border border-dashed border-gray-600 bg-gray-950 p-6 text-center'>
      <div className='w-full max-w-md'>
        <FileVideo className='mx-auto mb-4 h-14 w-14 text-gray-500' />
        <h2 className='text-base font-semibold text-gray-100'>元動画が見つかりません</h2>
        <p className='mt-1 text-sm text-gray-400'>
          削除済み、または利用できない動画を参照しています。別の動画を選んで紐づけ直してください。
        </p>
        <div className='mt-5 flex flex-col gap-2 sm:flex-row'>
          <select
            value={resolvedSelectedVideoId}
            onChange={(e) => setSelectedVideoId(e.target.value)}
            className='min-w-0 flex-1 rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100'
          >
            {videos.length === 0 && <option value=''>利用可能な動画がありません</option>}
            {videos.map((video) => (
              <option key={video.id} value={video.id}>
                {video.displayName}
              </option>
            ))}
          </select>
          <button
            type='button'
            onClick={() => onSubmit(resolvedSelectedVideoId)}
            disabled={loading || !resolvedSelectedVideoId}
            className='inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50'
          >
            <Link2 className='h-4 w-4' />
            {loading ? '保存中...' : '紐づけ'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditorLinkVideoModal({
  currentVideo,
  videos,
  loading,
  onSubmit,
  onClose,
}: {
  currentVideo: VideoAsset | null | undefined
  videos: VideoAsset[]
  loading: boolean
  onSubmit: (videoAssetId: string) => void
  onClose: () => void
}) {
  const [selectedVideoId, setSelectedVideoId] = useState(currentVideo?.id ?? videos[0]?.id ?? '')
  const resolvedSelectedVideoId = selectedVideoId || currentVideo?.id || videos[0]?.id || ''

  const submit = () => {
    if (!resolvedSelectedVideoId) return
    if (
      currentVideo &&
      resolvedSelectedVideoId !== currentVideo.id &&
      !confirm('動画を変更すると、字幕や切り抜き位置が新しい動画と合わなくなる場合があります。変更しますか？')
    ) {
      return
    }
    onSubmit(resolvedSelectedVideoId)
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={onClose}>
      <div
        className='w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800'
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className='mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100'>動画を変更</h2>
        {currentVideo && (
          <p className='mb-4 truncate text-sm text-gray-500 dark:text-gray-400'>現在: {currentVideo.displayName}</p>
        )}
        <label className='mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300'>元動画</label>
        <select
          value={resolvedSelectedVideoId}
          onChange={(e) => setSelectedVideoId(e.target.value)}
          className='w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
        >
          {videos.length === 0 && <option value=''>利用可能な動画がありません</option>}
          {videos.map((video) => (
            <option key={video.id} value={video.id}>
              {video.displayName}
            </option>
          ))}
        </select>
        <div className='mt-6 flex justify-end gap-2'>
          <button
            type='button'
            onClick={onClose}
            className='rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
          >
            キャンセル
          </button>
          <button
            type='button'
            onClick={submit}
            disabled={loading || !resolvedSelectedVideoId || resolvedSelectedVideoId === currentVideo?.id}
            className='inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50'
          >
            <Link2 className='h-4 w-4' />
            {loading ? '保存中...' : '変更'}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function clampTime(value: number, duration: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(value, duration || 0))
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10
}

function formatDecimalSeconds(value: number): string {
  return roundTime(value).toFixed(1)
}

function TrimPanel({
  duration,
  currentTime,
  keepSegments,
  onChange,
}: {
  duration: number
  currentTime: number
  keepSegments: KeepSegment[]
  onChange: (keepSegments: KeepSegment[]) => void
}) {
  const segment = keepSegments[0]
  const start = clampTime(segment?.sourceStart ?? 0, duration)
  const end = clampTime(segment?.sourceEnd ?? duration, duration)
  const trimLength = Math.max(0, end - start)
  const hasTrim = keepSegments.length > 0

  const saveRange = (nextStart: number, nextEnd: number) => {
    if (duration === 0) return

    const minLength = Math.min(0.1, duration)
    const maxStart = Math.max(0, duration - minLength)
    const sourceStart = clampTime(roundTime(Math.min(clampTime(nextStart, duration), maxStart)), maxStart)
    const sourceEnd = clampTime(roundTime(Math.max(clampTime(nextEnd, duration), sourceStart + minLength)), duration)

    if (sourceStart === 0 && sourceEnd === roundTime(duration)) {
      onChange([])
      return
    }

    onChange([
      {
        id: segment?.id ?? uuidv7(),
        sourceStart,
        sourceEnd,
      },
    ])
  }

  return (
    <section className='mb-6'>
      <div className='mb-3 flex items-center justify-between gap-3'>
        <h2 className='text-sm font-semibold text-gray-700 dark:text-gray-300'>切り抜き</h2>
        <span className='text-xs text-gray-400 dark:text-gray-500'>長さ {formatSeconds(trimLength)}</span>
      </div>

      <div className='rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-700/50'>
        <div className='grid grid-cols-2 gap-2'>
          <div>
            <label className='block text-xs text-gray-500 dark:text-gray-400'>開始 (秒)</label>
            <input
              type='number'
              value={formatDecimalSeconds(start)}
              step={0.1}
              min={0}
              max={duration}
              disabled={duration === 0}
              onChange={(e) => saveRange(Number(e.target.value), end)}
              className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-500 dark:text-gray-400'>終了 (秒)</label>
            <input
              type='number'
              value={formatDecimalSeconds(end)}
              step={0.1}
              min={0}
              max={duration}
              disabled={duration === 0}
              onChange={(e) => saveRange(start, Number(e.target.value))}
              className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
            />
          </div>
        </div>

        <div className='mt-3 grid grid-cols-2 gap-2'>
          <button
            type='button'
            onClick={() => saveRange(currentTime, end)}
            disabled={duration === 0}
            className='rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-gray-700 hover:bg-white disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
          >
            現在位置を開始にする
          </button>
          <button
            type='button'
            onClick={() => saveRange(start, currentTime)}
            disabled={duration === 0}
            className='rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-gray-700 hover:bg-white disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
          >
            現在位置を終了にする
          </button>
        </div>

        <button
          type='button'
          onClick={() => onChange([])}
          disabled={!hasTrim}
          className='mt-2 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-gray-600 hover:bg-white disabled:opacity-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700'
        >
          <RotateCcw className='h-3.5 w-3.5' />
          全体に戻す
        </button>
      </div>
    </section>
  )
}

function SubtitleEditorItem({
  item,
  templates,
  duration,
  onChange,
  onDelete,
}: {
  item: SubtitleItem
  templates: SubtitleTemplate[]
  duration: number
  onChange: (item: SubtitleItem) => void
  onDelete: () => void
}) {
  return (
    <div className='rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-600 dark:bg-gray-800'>
      <div className='mb-2 flex items-center gap-2'>
        <input
          type='text'
          value={item.text}
          onChange={(e) => onChange({ ...item, text: e.target.value })}
          className='flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
          placeholder='字幕テキスト'
        />
        <button
          onClick={onDelete}
          className='rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900 dark:hover:text-red-400'
          aria-label='字幕を削除'
          title='字幕を削除'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <div className='grid grid-cols-2 gap-2'>
        <div>
          <label className='block text-xs text-gray-500 dark:text-gray-400'>開始 (秒)</label>
          <input
            type='number'
            value={item.sourceStart}
            step={0.1}
            min={0}
            max={duration}
            onChange={(e) => onChange({ ...item, sourceStart: Number(e.target.value) })}
            className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
          />
        </div>
        <div>
          <label className='block text-xs text-gray-500 dark:text-gray-400'>終了 (秒)</label>
          <input
            type='number'
            value={item.sourceEnd}
            step={0.1}
            min={0}
            max={duration}
            onChange={(e) => onChange({ ...item, sourceEnd: Number(e.target.value) })}
            className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
          />
        </div>
      </div>
      {templates.length > 0 && (
        <select
          value={item.templateId}
          onChange={(e) => onChange({ ...item, templateId: e.target.value })}
          className='mt-2 w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function TimelineBar({
  duration,
  currentTime,
  keepSegments,
  subtitleItems,
  onSeek,
}: {
  duration: number
  currentTime: number
  keepSegments: KeepSegment[]
  subtitleItems: SubtitleItem[]
  onSeek: (time: number) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const toPercent = (value: number) => (duration > 0 ? (value / duration) * 100 : 0)
  const toWidthPercent = (start: number, end: number) => (duration > 0 ? ((end - start) / duration) * 100 : 0)

  const handleClick = (e: React.MouseEvent) => {
    const bar = barRef.current
    if (!bar || duration === 0) return
    const rect = bar.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    onSeek(Math.max(0, Math.min(ratio * duration, duration)))
  }

  return (
    <div className='h-20 border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800'>
      <div
        ref={barRef}
        className='relative h-10 cursor-pointer rounded bg-gray-100 dark:bg-gray-700'
        onClick={handleClick}
      >
        {keepSegments.map((seg) => (
          <div
            key={seg.id}
            className='absolute top-0 h-full rounded bg-green-200/70 dark:bg-green-800/40'
            style={{
              left: `${toPercent(seg.sourceStart)}%`,
              width: `${toWidthPercent(seg.sourceStart, seg.sourceEnd)}%`,
            }}
          />
        ))}

        {subtitleItems.map((sub) => (
          <div
            key={sub.id}
            className='absolute bottom-0 h-3 rounded bg-indigo-400/70 dark:bg-indigo-500/50'
            style={{
              left: `${toPercent(sub.sourceStart)}%`,
              width: `${toWidthPercent(sub.sourceStart, sub.sourceEnd)}%`,
            }}
            title={sub.text || '(空)'}
          />
        ))}

        <div className='absolute top-0 h-full w-0.5 bg-red-500' style={{ left: `${toPercent(currentTime)}%` }} />
      </div>
      <div className='mt-1 flex justify-between text-xs text-gray-400'>
        <span>{formatSeconds(currentTime)}</span>
        <span>{formatSeconds(duration)}</span>
      </div>
    </div>
  )
}

interface ExportJob {
  id: string
  status: string
  progress: number
  outputPath: string | null
  logPath: string | null
  errorMessage: string | null
  createdAt: string
}

function ExportPanel({ projectId, canExport }: { projectId: string; canExport: boolean }) {
  const queryClient = useQueryClient()
  const [showSettings, setShowSettings] = useState(false)
  const [preset, setPreset] = useState({
    videoCodec: 'libx264',
    crf: 23,
    format: 'mp4',
    audioCodec: 'aac',
    preset: 'medium' as const,
  })

  const { data: jobs } = useQuery<ExportJob[]>({
    queryKey: ['export-jobs', projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/export-jobs`).then((r) => r.json()),
    refetchInterval: 3000,
  })

  const createExport = useMutation({
    mutationFn: () =>
      fetch(`/api/projects/${projectId}/export-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['export-jobs', projectId] })
    },
  })

  const cancelExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['export-jobs', projectId] }),
  })

  const deleteExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['export-jobs', projectId] }),
  })

  return (
    <>
      <h2 className='mb-3 mt-6 text-sm font-semibold text-gray-700 dark:text-gray-300'>書き出し</h2>

      <button
        onClick={() => setShowSettings(!showSettings)}
        className='mb-2 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700'
      >
        {showSettings ? '設定を閉じる' : '書き出し設定'}
      </button>

      {showSettings && (
        <div className='mb-3 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-700/50'>
          <div>
            <label className='block text-xs text-gray-500 dark:text-gray-400'>ビデオコーデック</label>
            <select
              value={preset.videoCodec}
              onChange={(e) => setPreset({ ...preset, videoCodec: e.target.value })}
              className='w-full rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
            >
              <option value='libx264'>H.264</option>
              <option value='libx265'>H.265</option>
            </select>
          </div>
          <div>
            <label className='block text-xs text-gray-500 dark:text-gray-400'>品質 (CRF: 0-51, 低いほど高品質)</label>
            <input
              type='range'
              min={0}
              max={51}
              value={preset.crf}
              onChange={(e) => setPreset({ ...preset, crf: Number(e.target.value) })}
              className='w-full'
            />
            <span className='text-xs text-gray-400'>{preset.crf}</span>
          </div>
          <div>
            <label className='block text-xs text-gray-500 dark:text-gray-400'>エンコード速度</label>
            <select
              value={preset.preset}
              onChange={(e) => setPreset({ ...preset, preset: e.target.value as 'medium' })}
              className='w-full rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
            >
              <option value='ultrafast'>超高速</option>
              <option value='fast'>高速</option>
              <option value='medium'>標準</option>
              <option value='slow'>低速 (高圧縮)</option>
            </select>
          </div>
        </div>
      )}

      <button
        onClick={() => createExport.mutate()}
        disabled={createExport.isPending || !canExport}
        className='mb-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50'
      >
        <Download className='h-4 w-4' />
        {createExport.isPending ? '作成中...' : '書き出しを開始'}
      </button>
      {!canExport && (
        <p className='mb-3 text-xs text-amber-600 dark:text-amber-300'>動画を紐づけると書き出しできます。</p>
      )}

      <div className='space-y-2'>
        {jobs?.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            onCancel={() => cancelExport.mutate(job.id)}
            onDelete={() => deleteExport.mutate(job.id)}
          />
        ))}
        {(!jobs || jobs.length === 0) && (
          <p className='text-xs text-gray-400 dark:text-gray-500'>書き出し履歴がありません</p>
        )}
      </div>
    </>
  )
}

function JobCard({ job, onCancel, onDelete }: { job: ExportJob; onCancel: () => void; onDelete: () => void }) {
  const statusLabels: Record<string, string> = {
    queued: '待機中',
    running: '実行中',
    succeeded: '完了',
    failed: '失敗',
    canceling: 'キャンセル中',
    canceled: 'キャンセル済',
  }
  const statusColors: Record<string, string> = {
    queued: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
    running: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    succeeded: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    canceling: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
    canceled: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  }

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
