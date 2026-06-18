import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { uuidv7 } from 'uuidv7'
import { getDatabase } from '#/db'
import type { AppDatabase } from '#/db'
import {
  createExportJob,
  deleteExportJob,
  getExportJobById,
  getExportJobs,
  getExportJobsByProject,
  getIncompleteJobs,
  updateExportJob,
} from '#/server/features/export/export-repository'
import { exportWorker } from '#/server/features/export/export-worker'
import { parseByteRange } from '#/server/features/http/byte-range'
import { getProjectById, getProjects } from '#/server/features/projects/project-repository'
import { getVideoAssetById } from '#/server/features/videos/video-repository'
import type { HonoEnv } from '#/server/routes/shared'
import { CreateExportJobSchema } from '#/shared/schemas'

function ensureParam(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function summarizeExportError(
  logPath: string | null,
  exists = existsSync,
  readFile: (path: string, encoding: 'utf8') => string = readFileSync
): string | null {
  if (!logPath || !exists(logPath)) return null

  const log = readFile(logPath, 'utf8').slice(-12000)
  const lines = log
    .split('\n')
    .map((line) => line.replace(/^\[ERROR\]\s*/, '').trim())
    .filter(Boolean)

  const inputOpenLine = [...lines].reverse().find((line) => line.includes('Impossible to open'))
  if (inputOpenLine) {
    const match = inputOpenLine.match(/Impossible to open '([^']+)'/)
    return match ? `入力ファイルを開けません: ${match[1]}` : inputOpenLine
  }

  const relevantLine = [...lines]
    .reverse()
    .find((line) => /error|failed|invalid|unable|no such file/i.test(line) && !line.startsWith('configuration:'))

  return relevantLine ?? null
}

function removeExportFiles(
  jobId: string,
  removeDir: (path: string, options: { recursive: boolean; force: boolean }) => void = rmSync
) {
  const exportsRoot = resolve('data/exports')
  const exportDir = resolve(exportsRoot, jobId)
  if (!exportDir.startsWith(`${exportsRoot}/`)) {
    throw new Error('invalid export path')
  }
  removeDir(exportDir, { recursive: true, force: true })
}

type ExportWorkerLike = {
  enqueue: (jobId: string, db: AppDatabase) => void
  cancel: (jobId: string) => void
  onProgress: (jobId: string, callback: (progress: number, status: string) => void) => () => void
}

type ExportRouteDeps = {
  createId: () => string
  worker: ExportWorkerLike
  exists: (path: string) => boolean
  stat: (path: string) => { size: number }
  readFile: (path: string) => Uint8Array<ArrayBuffer>
  createReadStream: (path: string, options?: { start?: number; end?: number }) => Readable
  removeExportFiles: (jobId: string) => void
  summarizeExportError: (logPath: string | null) => string | null
}

const defaultExportRouteDeps: ExportRouteDeps = {
  createId: uuidv7,
  worker: exportWorker,
  exists: existsSync,
  stat: (path) => statSync(path),
  readFile: (path) => new Uint8Array(readFileSync(path)),
  createReadStream,
  removeExportFiles,
  summarizeExportError,
}

function createExportRoutes(deps: Partial<ExportRouteDeps> = {}) {
  const resolvedDeps = { ...defaultExportRouteDeps, ...deps }
  const exportRoutes = new Hono<HonoEnv>()

  exportRoutes.get('/', (c) => {
    const db = c.var.db
    const projectId = ensureParam(c.req.param('projectId'), 'projectId')
    const jobs = getExportJobsByProject(db, projectId)
    return c.json(
      jobs.map((job) => ({
        ...job,
        errorMessage: job.status === 'failed' ? resolvedDeps.summarizeExportError(job.logPath) : null,
      }))
    )
  })

  exportRoutes.post('/', sValidator('json', CreateExportJobSchema), (c) => {
    const db = c.var.db
    const projectId = ensureParam(c.req.param('projectId'), 'projectId')

    const project = getProjectById(db, projectId)
    if (!project) {
      return c.json({ error: 'project not found' }, 404)
    }
    const videoAsset = getVideoAssetById(db, project.videoAssetId)
    if (videoAsset?.status !== 'ready' || !videoAsset.storagePath) {
      return c.json({ error: 'video asset not ready' }, 400)
    }

    const body = c.req.valid('json')
    const job = createExportJob(db, {
      id: resolvedDeps.createId(),
      projectId,
      snapshot: project.timelineState as object | undefined,
      preset: body.preset as object | undefined,
    })

    resolvedDeps.worker.enqueue(job.id, db)

    return c.json(job, 201)
  })

  return exportRoutes
}

// REST endpoints for job actions: GET /api/export-jobs, GET /api/export-jobs/:exportJobId, etc.
function createJobRoutes(deps: Partial<ExportRouteDeps> = {}) {
  const resolvedDeps = { ...defaultExportRouteDeps, ...deps }
  const jobRoutes = new Hono<HonoEnv>()

  jobRoutes.get('/', (c) => {
    const db = c.var.db
    const rawLimit = c.req.query('limit') ?? '100'
    const parsed = Number(rawLimit)
    const limit = Number.isNaN(parsed) || parsed < 1 ? 100 : Math.min(parsed, 500)
    const jobs = getExportJobs(db, limit)
    const allProjects = getProjects(db)
    const projectMap = new Map(allProjects.map((p) => [p.id, p.name]))
    return c.json(
      jobs.map((job) => ({
        ...job,
        projectName: projectMap.get(job.projectId) ?? '',
        errorMessage: job.status === 'failed' ? resolvedDeps.summarizeExportError(job.logPath) : null,
      }))
    )
  })

  jobRoutes.get('/:exportJobId/events', (c) => {
    const db = c.var.db
    const jobId = c.req.param('exportJobId')

    const job = getExportJobById(db, jobId)
    if (!job) {
      return c.json({ error: 'not found' }, 404)
    }

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({ progress: job.progress, status: job.status }),
      })

      const unsubscribe = resolvedDeps.worker.onProgress(jobId, (progress, status) => {
        stream
          .writeSSE({
            data: JSON.stringify({ progress, status }),
          })
          .catch(() => {})
      })

      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: '' }).catch(() => {})
      }, 5000)

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const current = getExportJobById(db, jobId)
        if (
          !current ||
          current.status === 'succeeded' ||
          current.status === 'failed' ||
          current.status === 'canceled'
        ) {
          break
        }
      }

      clearInterval(keepAlive)
      unsubscribe()

      await stream.writeSSE({
        data: JSON.stringify({
          progress: getExportJobById(db, jobId)?.progress ?? 0,
          status: getExportJobById(db, jobId)?.status ?? 'failed',
        }),
      })
    })
  })

  jobRoutes.get('/:exportJobId', (c) => {
    const db = c.var.db
    const job = getExportJobById(db, c.req.param('exportJobId'))
    if (!job) {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json({
      ...job,
      errorMessage: job.status === 'failed' ? resolvedDeps.summarizeExportError(job.logPath) : null,
    })
  })

  jobRoutes.post('/:exportJobId/cancel', (c) => {
    const db = c.var.db
    const jobId = c.req.param('exportJobId')
    const job = getExportJobById(db, jobId)
    if (!job) {
      return c.json({ error: 'not found' }, 404)
    }
    if (job.status === 'queued' || job.status === 'running') {
      resolvedDeps.worker.cancel(jobId)
      updateExportJob(db, jobId, { status: 'canceled' })
    }
    return c.json(updateExportJob(db, jobId, {}))
  })

  jobRoutes.delete('/:exportJobId', (c) => {
    const db = c.var.db
    const jobId = c.req.param('exportJobId')
    const job = getExportJobById(db, jobId)
    if (!job) {
      return c.json({ error: 'not found' }, 404)
    }
    if (job.status === 'queued' || job.status === 'running' || job.status === 'canceling') {
      return c.json({ error: 'cancel export before deleting it' }, 409)
    }

    resolvedDeps.removeExportFiles(jobId)
    deleteExportJob(db, jobId)
    return c.body(null, 204)
  })

  jobRoutes.get('/:exportJobId/download', async (c) => {
    const db = c.var.db
    const job = getExportJobById(db, c.req.param('exportJobId'))
    if (!job) {
      return c.json({ error: 'not found' }, 404)
    }
    if (job.status !== 'succeeded' || !job.outputPath) {
      return c.json({ error: 'not ready' }, 400)
    }

    if (!resolvedDeps.exists(job.outputPath)) {
      return c.json({ error: 'output file not found' }, 404)
    }

    const file = resolvedDeps.readFile(job.outputPath)
    return c.body(file, 200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="export-${job.id}.mp4"`,
    })
  })

  jobRoutes.get('/:exportJobId/preview', async (c) => {
    const db = c.var.db
    const job = getExportJobById(db, c.req.param('exportJobId'))
    if (!job) {
      return c.json({ error: 'not found' }, 404)
    }
    if (job.status !== 'succeeded' || !job.outputPath) {
      return c.json({ error: 'not ready' }, 400)
    }
    if (!resolvedDeps.exists(job.outputPath)) {
      return c.json({ error: 'output file not found' }, 404)
    }

    const { size } = resolvedDeps.stat(job.outputPath)
    const rangeHeader = c.req.header('range')

    const baseHeaders = {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `inline; filename="export-${job.id}.mp4"`,
      'Accept-Ranges': 'bytes',
    }

    if (!rangeHeader) {
      const stream = resolvedDeps.createReadStream(job.outputPath)
      return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200, {
        ...baseHeaders,
        'Content-Length': String(size),
      })
    }

    const range = parseByteRange(rangeHeader, size)
    if (!range.ok) {
      return c.json({ error: 'range not satisfiable' }, 416, {
        'Content-Range': `bytes */${size}`,
      })
    }

    const { start, end, length } = range
    const stream = resolvedDeps.createReadStream(job.outputPath, { start, end })
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(length),
    })
  })

  return jobRoutes
}

const exportRoutes = createExportRoutes()
const jobRoutes = createJobRoutes()

export function recoverIncompleteJobs(options: { db?: AppDatabase; dbUrl?: string } = {}) {
  const db = options.db ?? getDatabase(options.dbUrl ?? process.env.DATABASE_URL ?? 'data/edit-vid2.db')
  const incomplete = getIncompleteJobs(db)
  for (const job of incomplete) {
    if (job.status === 'running') {
      updateExportJob(db, job.id, { status: 'failed' })
    }
    if (job.status === 'canceling') {
      updateExportJob(db, job.id, { status: 'canceled' })
    }
  }
}

export { createExportRoutes, createJobRoutes, exportRoutes, jobRoutes, removeExportFiles, summarizeExportError }
