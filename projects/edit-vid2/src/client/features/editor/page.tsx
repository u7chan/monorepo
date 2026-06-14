import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Download, FileVideo, ImageIcon, Link2, LoaderCircle, RotateCcw, Type, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { uuidv7 } from 'uuidv7'
import { JobCard, type ExportJob } from '#/client/features/exports/job-card'
import type {
  KeepSegment,
  Project,
  SubtitleItem,
  SubtitleTemplate,
  TimelineStateV1,
  VideoAsset,
} from '#/shared/schemas'
import { getRenderableSubtitles, sortSubtitleItemsByStart } from '#/shared/subtitles'

export function EditorPage() {
  const params = useParams({ from: '/projects/$projectId' })
  const projectId = params.projectId
  const queryClient = useQueryClient()
  const videoRef = useRef<HTMLVideoElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [showLinkVideo, setShowLinkVideo] = useState(false)
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null)

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
    (newState: TimelineStateV1, options?: { onSuccess?: () => void }) => {
      updateProject.mutate({ timelineState: newState }, { onSuccess: options?.onSuccess })
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

  // Query refresh or project loading can swap the video outside linkVideo.onSuccess.
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
    saveTimelineState(
      { ...timelineState, tracks: updatedTracks },
      { onSuccess: () => setSelectedSubtitleId(newItem.id) }
    )
  }

  const subItems: SubtitleItem[] = timelineState.tracks.find((t) => t.type === 'subtitle')?.items ?? []
  const sortedSubItems = useMemo(() => sortSubtitleItemsByStart(subItems), [subItems])
  const renderableSubItems = getRenderableSubtitles(sortedSubItems)

  return (
    <div
      ref={rootRef}
      data-testid='editor-root'
      tabIndex={-1}
      autoFocus
      className='flex h-full flex-col outline-none'
      onClick={(e) => {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return
        rootRef.current?.focus()
      }}
      onKeyDown={(e) => {
        if (e.code !== 'Space') return
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        const video = videoRef.current
        if (!video) return
        if (video.paused) {
          video.play()
        } else {
          video.pause()
        }
      }}
    >
      <div className='flex items-center gap-4 border-b border-gray-200 px-4 py-3 dark:border-gray-700'>
        <Link
          to='/projects'
          className='rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
        >
          <ArrowLeft className='h-5 w-5' />
        </Link>
        <h1 data-testid='editor-title' className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
          {project?.name ?? 'エディタ'}
        </h1>
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

        <div className='flex w-full flex-col overflow-hidden border-t border-gray-200 dark:border-gray-700 lg:w-96 lg:border-l lg:border-t-0'>
          <div className='shrink-0 p-4 pb-2'>
            <TrimPanel
              duration={mediaDuration}
              currentTime={currentTime}
              keepSegments={timelineState.keepSegments}
              onChange={(keepSegments) => saveTimelineState({ ...timelineState, keepSegments })}
            />
          </div>

          <div className='flex min-h-0 flex-1 flex-col px-4'>
            {selectedSubtitleId ? (
              (() => {
                const selectedItem = sortedSubItems.find((s) => s.id === selectedSubtitleId)
                if (!selectedItem) {
                  return (
                    <div className='flex flex-1 flex-col items-center justify-center text-center'>
                      <Type className='mb-2 h-8 w-8 text-gray-300 dark:text-gray-600' />
                      <p className='text-sm text-gray-500 dark:text-gray-400'>選択した字幕が見つかりません</p>
                    </div>
                  )
                }
                return (
                  <SubtitleDetailForm
                    key={selectedSubtitleId}
                    projectId={projectId}
                    item={selectedItem}
                    templates={templates ?? []}
                    duration={mediaDuration}
                    canPreview={hasVideo}
                    onChange={(updated) => {
                      const newItems = subItems.map((s) => (s.id === updated.id ? updated : s))
                      const newTracks = timelineState.tracks.map((t) =>
                        t.type === 'subtitle' ? { ...t, items: newItems } : t
                      )
                      saveTimelineState({ ...timelineState, tracks: newTracks })
                    }}
                    onDelete={() => {
                      const newItems = subItems.filter((s) => s.id !== selectedSubtitleId)
                      const newTracks = timelineState.tracks.map((t) =>
                        t.type === 'subtitle' ? { ...t, items: newItems } : t
                      )
                      setSelectedSubtitleId(null)
                      saveTimelineState({ ...timelineState, tracks: newTracks })
                    }}
                  />
                )
              })()
            ) : (
              <div className='flex flex-1 flex-col items-center justify-center text-center'>
                <Type className='mb-2 h-8 w-8 text-gray-300 dark:text-gray-600' />
                <p className='text-sm text-gray-500 dark:text-gray-400'>字幕を選択すると詳細が表示されます</p>
                <p className='mt-1 text-xs text-gray-400 dark:text-gray-500'>
                  タイムラインのクリップをクリックするか、「字幕追加」ボタンで追加してください
                </p>
              </div>
            )}
          </div>

          <div className='shrink-0 border-t border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800'>
            <ExportPanel projectId={projectId} canExport={hasVideo} />
          </div>
        </div>
      </div>

      <TimelineBar
        duration={mediaDuration}
        currentTime={currentTime}
        keepSegments={timelineState.keepSegments}
        subtitleItems={renderableSubItems}
        selectedId={selectedSubtitleId}
        onSelect={setSelectedSubtitleId}
        onChange={(updated) => {
          const newItems = subItems.map((s) => (s.id === updated.id ? updated : s))
          const newTracks = timelineState.tracks.map((t) => (t.type === 'subtitle' ? { ...t, items: newItems } : t))
          saveTimelineState({ ...timelineState, tracks: newTracks })
        }}
        onPause={() => videoRef.current?.pause()}
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

function TimeField({
  value,
  min,
  max,
  disabled,
  testId,
  onCommit,
}: {
  value: number
  min: number
  max: number
  disabled: boolean
  testId?: string
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(formatDecimalSeconds(value))
  const [isFocused, setIsFocused] = useState(false)
  const valueRef = useRef(value)

  if (value !== valueRef.current && !isFocused) {
    valueRef.current = value
    const formatted = formatDecimalSeconds(value)
    if (draft !== formatted) {
      setDraft(formatted)
    }
  }

  const isValidDecimal = (raw: string): boolean => {
    const trimmed = raw.trim()
    if (trimmed === '') return false
    return /^-?\d+(\.\d*)?$/.test(trimmed) && Number.isFinite(Number(trimmed))
  }

  const commit = (raw: string) => {
    setIsFocused(false)
    if (!isValidDecimal(raw)) {
      setDraft(formatDecimalSeconds(value))
      return
    }
    const parsed = Number(raw)
    const next = Math.max(min, Math.min(parsed, max))
    onCommit(next)
    setDraft(formatDecimalSeconds(next))
  }

  return (
    <input
      type='text'
      inputMode='decimal'
      disabled={disabled}
      data-testid={testId}
      value={draft}
      onFocus={() => {
        valueRef.current = value
        setDraft(formatDecimalSeconds(value))
        setIsFocused(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.currentTarget.blur()
      }}
      className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
    />
  )
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
            <TimeField
              value={start}
              min={0}
              max={duration}
              disabled={duration === 0}
              testId='trim-start-input'
              onCommit={(nextStart) => saveRange(nextStart, end)}
            />
          </div>
          <div>
            <label className='block text-xs text-gray-500 dark:text-gray-400'>終了 (秒)</label>
            <TimeField
              value={end}
              min={0}
              max={duration}
              disabled={duration === 0}
              testId='trim-end-input'
              onCommit={(nextEnd) => saveRange(start, nextEnd)}
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

function SubtitleDetailForm({
  projectId,
  item,
  templates,
  duration,
  canPreview,
  onChange,
  onDelete,
}: {
  projectId: string
  item: SubtitleItem
  templates: SubtitleTemplate[]
  duration: number
  canPreview: boolean
  onChange: (item: SubtitleItem) => void
  onDelete: () => void
}) {
  const previewText = item.text.trim()
  const previewSourceTime = Math.max(0, Number(item.sourceStart.toFixed(2)))
  const previewQuery = useQuery<{ path: string; cached: boolean }>({
    queryKey: ['subtitle-preview', projectId, item.id, previewSourceTime, previewText, item.templateId],
    enabled: canPreview && previewText.length > 0,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/previews/subtitle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceTime: previewSourceTime,
          text: previewText,
          templateId: item.templateId,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? 'preview generation failed')
      }
      return res.json()
    },
  })
  const previewSrc = previewQuery.data?.path
    ? previewQuery.data.path.startsWith('/')
      ? previewQuery.data.path
      : `/${previewQuery.data.path}`
    : null

  return (
    <div data-testid='subtitle-detail-form' className='flex min-h-0 flex-1 flex-col overflow-y-auto py-4'>
      <div className='mb-4 flex items-center justify-between'>
        <h2 className='text-sm font-semibold text-gray-700 dark:text-gray-300'>字幕詳細</h2>
        <button
          onClick={onDelete}
          className='rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900 dark:hover:text-red-400'
          aria-label='字幕を削除'
          title='字幕を削除'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <div className='space-y-3'>
        <div>
          <label className='mb-1 block text-xs text-gray-500 dark:text-gray-400'>テキスト</label>
          <SubtitleTextInput item={item} onChange={onChange} />
        </div>
        <div className='grid grid-cols-2 gap-3'>
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
          <div>
            <label className='mb-1 block text-xs text-gray-500 dark:text-gray-400'>テンプレート</label>
            <select
              value={item.templateId}
              onChange={(e) => onChange({ ...item, templateId: e.target.value })}
              className='w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <section
          data-testid='subtitle-preview'
          className='overflow-hidden rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900'
        >
          <div className='flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700'>
            <ImageIcon className='h-3.5 w-3.5 text-gray-500 dark:text-gray-400' />
            <h3 className='text-xs font-medium text-gray-600 dark:text-gray-300'>静止画プレビュー</h3>
          </div>
          <div className='flex aspect-video items-center justify-center bg-gray-100 text-xs text-gray-500 dark:bg-gray-950 dark:text-gray-400'>
            {!canPreview ? (
              <span>元動画が必要です</span>
            ) : previewText.length === 0 ? (
              <span>テキスト入力後に表示されます</span>
            ) : previewQuery.isFetching ? (
              <span className='inline-flex items-center gap-2'>
                <LoaderCircle className='h-3.5 w-3.5 animate-spin' />
                生成中...
              </span>
            ) : previewQuery.isError ? (
              <span>プレビューを生成できませんでした</span>
            ) : previewSrc ? (
              <img
                data-testid='subtitle-preview-image'
                src={previewSrc}
                alt='字幕プレビュー'
                className='h-full w-full object-contain'
              />
            ) : (
              <span>プレビュー未生成</span>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function SubtitleTextInput({ item, onChange }: { item: SubtitleItem; onChange: (item: SubtitleItem) => void }) {
  const [draftText, setDraftText] = useState(item.text)
  const isComposingRef = useRef(false)
  const committedTextRef = useRef(item.text)
  const pendingTextRef = useRef<string | null>(null)
  const itemIdRef = useRef(item.id)

  let inputText = draftText
  if (itemIdRef.current !== item.id) {
    itemIdRef.current = item.id
    pendingTextRef.current = null
    committedTextRef.current = item.text
    inputText = item.text
    if (draftText !== item.text) {
      setDraftText(item.text)
    }
  } else if (!isComposingRef.current && pendingTextRef.current !== null) {
    if (item.text === pendingTextRef.current) {
      pendingTextRef.current = null
    }
  } else if (!isComposingRef.current && committedTextRef.current !== item.text) {
    committedTextRef.current = item.text
    inputText = item.text
    if (draftText !== item.text) {
      setDraftText(item.text)
    }
  }

  const commitText = (text: string) => {
    if (text === committedTextRef.current) return
    committedTextRef.current = text
    pendingTextRef.current = text
    onChange({ ...item, text })
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value
    const nativeEvent = e.nativeEvent as InputEvent
    setDraftText(text)
    if (isComposingRef.current || nativeEvent.isComposing) return
    commitText(text)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    if (isComposingRef.current || e.nativeEvent.isComposing) return
    commitText(e.currentTarget.value)
  }

  return (
    <input
      type='text'
      value={inputText}
      onChange={handleChange}
      onCompositionStart={() => {
        isComposingRef.current = true
      }}
      onCompositionEnd={(e) => {
        isComposingRef.current = false
        const text = e.currentTarget.value
        setDraftText(text)
        commitText(text)
      }}
      onBlur={(e) => {
        isComposingRef.current = false
        const text = e.currentTarget.value
        setDraftText(text)
        commitText(text)
      }}
      onKeyDown={handleKeyDown}
      className='flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
      placeholder='字幕テキスト'
    />
  )
}

type DragMode = 'move' | 'resize-start' | 'resize-end'

function TimelineBar({
  duration,
  currentTime,
  keepSegments,
  subtitleItems,
  selectedId,
  onSelect,
  onChange,
  onPause,
  onSeek,
}: {
  duration: number
  currentTime: number
  keepSegments: KeepSegment[]
  subtitleItems: SubtitleItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (item: SubtitleItem) => void
  onPause: () => void
  onSeek: (time: number) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const seekingRef = useRef(false)
  const dragRef = useRef<{
    id: string
    mode: DragMode
    startX: number
    startSourceStart: number
    startSourceEnd: number
    previewSourceStart: number
    previewSourceEnd: number
  } | null>(null)
  const [dragPreview, setDragPreview] = useState<{ id: string; sourceStart: number; sourceEnd: number } | null>(null)
  const toPercent = (value: number) => (duration > 0 ? (value / duration) * 100 : 0)
  const toWidthPercent = (start: number, end: number) => (duration > 0 ? ((end - start) / duration) * 100 : 0)

  const calcTime = (clientX: number) => {
    const bar = barRef.current
    if (!bar || duration === 0) return 0
    const rect = bar.getBoundingClientRect()
    const ratio = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(ratio * duration, duration))
  }

  const calcDeltaTime = (clientX: number) => {
    const bar = barRef.current
    if (!bar || duration === 0) return 0
    const rect = bar.getBoundingClientRect()
    return ((clientX - rect.left) / rect.width) * duration - calcTime(dragRef.current?.startX ?? clientX)
  }

  const clampItemRange = (nextStart: number, nextEnd: number) => {
    const minLength = 0.1
    const sourceStart = Math.max(0, Math.min(roundTime(nextStart), duration - minLength))
    const sourceEnd = Math.max(sourceStart + minLength, Math.min(roundTime(nextEnd), duration))
    return { sourceStart, sourceEnd }
  }

  const stopDrag = () => {
    dragRef.current = null
    setDragPreview(null)
    document.removeEventListener('mousemove', handleItemMouseMove)
    document.removeEventListener('mouseup', handleItemMouseUp)
  }

  const handleItemMouseMove = (ev: MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    ev.preventDefault()
    const delta = calcDeltaTime(ev.clientX)
    const { id, mode, startSourceStart, startSourceEnd } = drag
    let nextStart = startSourceStart
    let nextEnd = startSourceEnd
    if (mode === 'move') {
      const originalDuration = startSourceEnd - startSourceStart
      nextStart = startSourceStart + delta
      nextEnd = startSourceEnd + delta
      if (nextEnd > duration) {
        nextEnd = duration
        nextStart = Math.max(0, duration - originalDuration)
      }
      if (nextStart < 0) {
        nextStart = 0
        nextEnd = Math.min(duration, originalDuration)
      }
    } else if (mode === 'resize-start') {
      nextStart = startSourceStart + delta
    } else {
      nextEnd = startSourceEnd + delta
    }
    const { sourceStart, sourceEnd } = clampItemRange(nextStart, nextEnd)
    drag.previewSourceStart = sourceStart
    drag.previewSourceEnd = sourceEnd
    setDragPreview({ id, sourceStart, sourceEnd })
  }

  const handleItemMouseUp = () => {
    const drag = dragRef.current
    if (drag) {
      const item = subtitleItems.find((s) => s.id === drag.id)
      if (item) {
        const { sourceStart, sourceEnd } = clampItemRange(drag.previewSourceStart, drag.previewSourceEnd)
        if (sourceStart !== item.sourceStart || sourceEnd !== item.sourceEnd) {
          onChange({ ...item, sourceStart, sourceEnd })
        }
      }
    }
    stopDrag()
  }

  const startItemDrag = (e: React.MouseEvent, item: SubtitleItem, mode: DragMode) => {
    e.stopPropagation()
    if (e.button !== 0) return
    onPause()
    onSelect(item.id)
    dragRef.current = {
      id: item.id,
      mode,
      startX: e.clientX,
      startSourceStart: item.sourceStart,
      startSourceEnd: item.sourceEnd,
      previewSourceStart: item.sourceStart,
      previewSourceEnd: item.sourceEnd,
    }
    document.addEventListener('mousemove', handleItemMouseMove)
    document.addEventListener('mouseup', handleItemMouseUp)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    onSelect(null)
    seekingRef.current = true
    onPause()
    onSeek(calcTime(e.clientX))

    const handleMouseMove = (ev: MouseEvent) => {
      if (!seekingRef.current) return
      onSeek(calcTime(ev.clientX))
    }

    const handleMouseUp = () => {
      seekingRef.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 0) return
    seekingRef.current = true
    onPause()
    onSeek(calcTime(e.touches[0].clientX))
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!seekingRef.current || e.touches.length === 0) return
    onSeek(calcTime(e.touches[0].clientX))
  }

  const handleTouchEnd = () => {
    seekingRef.current = false
  }

  return (
    <div className='h-24 border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800'>
      <div
        ref={barRef}
        data-testid='timeline-seek-bar'
        className='relative h-14 cursor-pointer rounded bg-gray-100 dark:bg-gray-700'
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
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

        {subtitleItems.map((sub) => {
          const isSelected = sub.id === selectedId
          const preview = dragPreview?.id === sub.id ? dragPreview : null
          const sourceStart = preview?.sourceStart ?? sub.sourceStart
          const sourceEnd = preview?.sourceEnd ?? sub.sourceEnd
          return (
            <div
              key={sub.id}
              data-testid='timeline-subtitle-item'
              data-subtitle-id={sub.id}
              onMouseDown={(e) => startItemDrag(e, sub, 'move')}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(sub.id)
              }}
              className={[
                'group absolute bottom-1 h-5 cursor-grab rounded border border-indigo-500/30 bg-indigo-400/70 dark:bg-indigo-500/50',
                isSelected ? 'ring-2 ring-indigo-500' : '',
              ].join(' ')}
              style={{
                left: `${toPercent(sourceStart)}%`,
                width: `${toWidthPercent(sourceStart, sourceEnd)}%`,
                minWidth: '4px',
              }}
              title={sub.text || '(空)'}
            >
              {isSelected && (
                <>
                  <div
                    data-testid='timeline-subtitle-resize-start'
                    onMouseDown={(e) => startItemDrag(e, sub, 'resize-start')}
                    className='absolute -left-1.5 top-0 h-full w-3 cursor-w-resize'
                  />
                  <div
                    data-testid='timeline-subtitle-resize-end'
                    onMouseDown={(e) => startItemDrag(e, sub, 'resize-end')}
                    className='absolute -right-1.5 top-0 h-full w-3 cursor-e-resize'
                  />
                </>
              )}
            </div>
          )
        })}

        <div className='absolute top-0 h-full w-0.5 bg-red-500' style={{ left: `${toPercent(currentTime)}%` }} />
      </div>
      <div className='mt-1 flex justify-between text-xs text-gray-400'>
        <span data-testid='timeline-current-time'>{formatSeconds(currentTime)}</span>
        <span>{formatSeconds(duration)}</span>
      </div>
    </div>
  )
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
      queryClient.invalidateQueries({ queryKey: ['export-jobs'] })
    },
  })

  const cancelExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['export-jobs', projectId] })
      queryClient.invalidateQueries({ queryKey: ['export-jobs'] })
    },
  })

  const deleteExport = useMutation({
    mutationFn: (jobId: string) => fetch(`/api/export-jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['export-jobs', projectId] })
      queryClient.invalidateQueries({ queryKey: ['export-jobs'] })
    },
  })

  const latestJob = jobs?.[0]

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

      {latestJob ? (
        <JobCard
          job={latestJob}
          onCancel={() => cancelExport.mutate(latestJob.id)}
          onDelete={() => deleteExport.mutate(latestJob.id)}
        />
      ) : (
        <p className='text-xs text-gray-400 dark:text-gray-500'>書き出し履歴がありません</p>
      )}
      <div className='mt-2'>
        <Link to='/exports' className='text-xs text-indigo-600 hover:underline dark:text-indigo-400'>
          書き出し履歴を表示
        </Link>
      </div>
    </>
  )
}
