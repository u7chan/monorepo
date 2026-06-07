import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AppDatabase } from '#/db'
import { generateAssContent } from '#/server/features/ass/ass-generator'
import { getProjectById } from '#/server/features/projects/project-repository'
import { getTemplateById } from '#/server/features/templates/template-repository'
import { mapSubtitlesToOutputTime, normalizeKeepSegments } from '#/server/features/timeline/timeline-logic'
import { getVideoAssetById } from '#/server/features/videos/video-repository'
import { toSubtitleStyle } from '#/shared/schemas'
import type { ExportPreset, KeepSegment, SubtitleItem, SubtitleStyle, TimelineStateV1 } from '#/shared/schemas'
import { getExportJobById, updateExportJob } from './export-repository'

interface ExportJobRecord {
  id: string
  projectId: string
  status: string
  snapshot: unknown
  preset: unknown
}

function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function buildSubtitleFilter(assPath: string): string {
  return `subtitles='${escapeFilterPath(assPath)}'`
}

export function buildVideoEncodeArgs(preset: ExportPreset): string {
  const args = [`-c:v ${preset.videoCodec}`, `-crf ${preset.crf}`, `-preset ${preset.preset}`]

  if (preset.videoCodec === 'libx264') {
    args.push('-profile:v high', '-level 4.1', '-pix_fmt yuv420p', '-tag:v avc1')
  }

  return args.join(' ')
}

function buildAudioEncodeArgs(audioCodec: ExportPreset['audioCodec']): string {
  if (audioCodec === 'copy') return '-c:a copy'
  return `-c:a ${audioCodec}`
}

export function buildMp4OutputArgs(): string {
  return '-movflags +faststart'
}

function buildTrimFilter(normalized: KeepSegment[], hasAudio: boolean, subtitleFilter: string) {
  const parts: string[] = []

  for (let i = 0; i < normalized.length; i++) {
    const segment = normalized[i]
    parts.push(`[0:v]trim=start=${segment.sourceStart}:end=${segment.sourceEnd},setpts=PTS-STARTPTS[v${i}]`)
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${segment.sourceStart}:end=${segment.sourceEnd},asetpts=PTS-STARTPTS[a${i}]`)
    }
  }

  let videoLabel: string
  let audioLabel: string | null = null

  if (normalized.length === 1) {
    videoLabel = 'v0'
    audioLabel = hasAudio ? 'a0' : null
  } else if (hasAudio) {
    const inputs = normalized.map((_, i) => `[v${i}][a${i}]`).join('')
    parts.push(`${inputs}concat=n=${normalized.length}:v=1:a=1[vcat][acat]`)
    videoLabel = 'vcat'
    audioLabel = 'acat'
  } else {
    const inputs = normalized.map((_, i) => `[v${i}]`).join('')
    parts.push(`${inputs}concat=n=${normalized.length}:v=1:a=0[vcat]`)
    videoLabel = 'vcat'
  }

  if (subtitleFilter) {
    parts.push(`[${videoLabel}]${subtitleFilter}[vout]`)
    videoLabel = 'vout'
  }

  return {
    graph: parts.join(';'),
    videoMap: `[${videoLabel}]`,
    audioMap: audioLabel ? `[${audioLabel}]` : null,
  }
}

class ExportWorker {
  private running = false
  private currentJobId: string | null = null
  private queue: Array<{ jobId: string; db: AppDatabase }> = []
  private currentProcess: { kill: () => void } | null = null
  private progressCallbacks = new Map<string, (progress: number, status: string) => void>()

  onProgress(jobId: string, callback: (progress: number, status: string) => void) {
    this.progressCallbacks.set(jobId, callback)
    return () => this.progressCallbacks.delete(jobId)
  }

  enqueue(jobId: string, db: AppDatabase) {
    this.queue.push({ jobId, db })
    this.processNext()
  }

  cancel(jobId: string) {
    // If currently running this job, kill the process
    if (this.currentJobId === jobId && this.currentProcess) {
      this.currentProcess.kill()
      this.currentProcess = null
      this.currentJobId = null
      return
    }
    // If queued but not yet started, remove from queue
    this.queue = this.queue.filter((j) => j.jobId !== jobId)
  }

  private async processNext() {
    if (this.running || this.queue.length === 0) return
    this.running = true

    const job = this.queue.shift()!
    const { jobId, db } = job
    this.currentJobId = jobId

    try {
      updateExportJob(db, jobId, { status: 'running', progress: 0 })
      this.notifyProgress(jobId, 0, 'running')

      const exportJob = updateExportJob(db, jobId, {}) as ExportJobRecord | undefined
      if (!exportJob) throw new Error('job not found')

      const project = getProjectById(db, exportJob.projectId)
      if (!project) throw new Error('project not found')

      const videoAsset = getVideoAssetById(db, project.videoAssetId)
      if (!videoAsset || !videoAsset.storagePath) throw new Error('video asset not found')
      const videoPath = resolve(videoAsset.storagePath)

      const timelineState = (exportJob.snapshot as TimelineStateV1) ?? (project.timelineState as TimelineStateV1 | null)
      if (!timelineState) throw new Error('no timeline state')

      const keepSegments: KeepSegment[] = timelineState.keepSegments ?? []
      const subItems: SubtitleItem[] = timelineState.tracks?.find((t) => t.type === 'subtitle')?.items ?? []

      const preset = (exportJob.preset ?? {
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
        crf: 23,
        preset: 'medium',
      }) as ExportPreset

      const exportDir = `data/exports/${jobId}`
      mkdirSync(exportDir, { recursive: true })
      const outputPath = `${exportDir}/output.mp4`
      const logPath = `${exportDir}/ffmpeg.log`

      updateExportJob(db, jobId, { outputPath, logPath })

      // Build ASS if there are subtitles
      let vfFilter = ''
      let assPath = ''

      if (subItems.length > 0) {
        const defaultTemplate = getTemplateById(db, subItems[0]?.templateId ?? '')
        const defaultStyle: SubtitleStyle = defaultTemplate
          ? toSubtitleStyle(defaultTemplate)
          : {
              fontFamilyId: 'default',
              fontSize: 48,
              fontColor: '#FFFFFF',
              bold: false,
              italic: false,
              outlineColor: '#000000',
              outlineWidth: 2,
              shadow: { enabled: false, color: '#000000', offsetX: 0, offsetY: 0, blur: 0 },
              backgroundBox: { enabled: false, color: '#000000', opacity: 0.6, padding: 4 },
              position: 'bottom',
              margin: { x: 0, y: 0 },
            }

        const mapped = mapSubtitlesToOutputTime(subItems, keepSegments)
        const assContent = generateAssContent(mapped, videoAsset.width ?? 1920, videoAsset.height ?? 1080, defaultStyle)
        assPath = resolve(exportDir, 'subtitles.ass')
        const { writeFileSync } = await import('node:fs')
        writeFileSync(assPath, assContent)
        vfFilter = buildSubtitleFilter(assPath)
      }

      // Build ffmpeg command for trim + concat
      const normalized = normalizeKeepSegments(keepSegments)

      let ffmpegCmd: string
      const videoEncodeArgs = buildVideoEncodeArgs(preset)
      const outputArgs = buildMp4OutputArgs()
      if (normalized.length === 0) {
        // No trim: render entire video
        const filterPart = vfFilter ? ` -vf "${vfFilter}"` : ''
        const audioEncodeArgs = buildAudioEncodeArgs(preset.audioCodec)
        ffmpegCmd = `ffmpeg -y -i "${videoPath}"${filterPart} ${videoEncodeArgs} ${audioEncodeArgs} ${outputArgs} -progress pipe:1 -nostats "${outputPath}"`
      } else {
        const hasAudio = videoAsset.hasAudio === true
        const trimFilter = buildTrimFilter(normalized, hasAudio, vfFilter)
        const audioPart = trimFilter.audioMap
          ? ` -map "${trimFilter.audioMap}" -c:a ${preset.audioCodec === 'copy' ? 'aac' : preset.audioCodec}`
          : ' -an'
        ffmpegCmd = `ffmpeg -y -i "${videoPath}" -filter_complex "${trimFilter.graph}" -map "${trimFilter.videoMap}"${audioPart} ${videoEncodeArgs} ${outputArgs} -progress pipe:1 -nostats "${outputPath}"`
      }

      updateExportJob(db, jobId, { progress: 5 })

      const proc = Bun.spawn(['sh', '-c', ffmpegCmd], {
        stdout: 'pipe',
        stderr: 'pipe',
      })

      this.currentProcess = { kill: () => proc.kill() }

      let lastProgress = 5
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        appendFileSync(logPath, decoder.decode(value, { stream: true }))

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('out_time_ms=')) {
            const ms = Number(line.substring(12))
            if (videoAsset.duration && videoAsset.duration > 0) {
              const totalDuration =
                normalized.length > 0
                  ? normalized.reduce((sum, seg) => sum + (seg.sourceEnd - seg.sourceStart), 0)
                  : videoAsset.duration
              const progress = Math.min(5 + (ms / 1_000_000 / totalDuration) * 90, 95)
              if (progress > lastProgress + 1) {
                lastProgress = Math.round(progress)
                updateExportJob(db, jobId, { progress: lastProgress })
                this.notifyProgress(jobId, lastProgress, 'running')
              }
            }
          }
          if (line.startsWith('progress=end')) {
            lastProgress = 95
          }
        }
      }

      await proc.exited

      if (proc.exitCode === 0) {
        updateExportJob(db, jobId, { status: 'succeeded', progress: 100 })
        this.notifyProgress(jobId, 100, 'succeeded')
      } else {
        const errReader = proc.stderr.getReader()
        let errText = ''
        while (true) {
          const { done, value } = await errReader.read()
          if (done) break
          errText += decoder.decode(value)
        }
        appendFileSync(logPath, `\n[ERROR] ${errText}`)
        throw new Error(`ffmpeg exited with code ${proc.exitCode}`)
      }
    } catch (err) {
      const current = getExportJobById(db, jobId)
      if (current?.status === 'canceled' || current?.status === 'canceling') {
        return
      }
      const message = err instanceof Error ? err.message : 'unknown error'
      updateExportJob(db, jobId, { status: 'failed', progress: 0 })
      this.notifyProgress(jobId, 0, `failed: ${message}`)
      console.error(`[export-worker] job ${jobId} failed:`, message)
    } finally {
      this.currentProcess = null
      this.currentJobId = null
      this.running = false
      this.processNext()
    }
  }

  private notifyProgress(jobId: string, progress: number, status: string) {
    const cb = this.progressCallbacks.get(jobId)
    if (cb) cb(progress, status)
  }
}

export const exportWorker = new ExportWorker()
