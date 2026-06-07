import { sValidator } from '@hono/standard-validator'
import { createExportJob, getExportJobById, getExportJobsByProject, getIncompleteJobs, updateExportJob } from '#/server/features/export/export-repository'
import { exportWorker } from '#/server/features/export/export-worker'
import { getProjectById } from '#/server/features/projects/project-repository'
import type { HonoEnv } from '#/server/routes/shared'
import { CreateExportJobSchema } from '#/shared/schemas'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { uuidv7 } from 'uuidv7'

function ensureParam(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

const exportRoutes = new Hono<HonoEnv>()

exportRoutes.get('/', (c) => {
  const db = c.var.db
  const projectId = ensureParam(c.req.param('projectId'), 'projectId')
  const jobs = getExportJobsByProject(db, projectId)
  return c.json(jobs)
})

exportRoutes.post('/', sValidator('json', CreateExportJobSchema), (c) => {
  const db = c.var.db
  const projectId = ensureParam(c.req.param('projectId'), 'projectId')

  const project = getProjectById(db, projectId)
  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }

  const body = c.req.valid('json')
  const job = createExportJob(db, {
    id: uuidv7(),
    projectId,
    snapshot: project.timelineState as object | undefined,
    preset: body.preset as object | undefined,
  })

  exportWorker.enqueue(job.id, db)

  return c.json(job, 201)
})

// SSE endpoint: GET /api/export-jobs/:exportJobId/events
const sseRoutes = new Hono<HonoEnv>()

sseRoutes.get('/:exportJobId/events', (c) => {
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

    const unsubscribe = exportWorker.onProgress(jobId, (progress, status) => {
      stream.writeSSE({
        data: JSON.stringify({ progress, status }),
      }).catch(() => {})
    })

    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: '' }).catch(() => {})
    }, 5000)

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const current = getExportJobById(db, jobId)
      if (!current || current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled') {
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

sseRoutes.get('/:exportJobId', (c) => {
  const db = c.var.db
  const job = getExportJobById(db, c.req.param('exportJobId'))
  if (!job) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json(job)
})

sseRoutes.post('/:exportJobId/cancel', (c) => {
  const db = c.var.db
  const jobId = c.req.param('exportJobId')
  const job = getExportJobById(db, jobId)
  if (!job) {
    return c.json({ error: 'not found' }, 404)
  }
  if (job.status === 'queued' || job.status === 'running') {
    exportWorker.cancel(jobId)
    updateExportJob(db, jobId, { status: 'canceled' })
  }
  return c.json(updateExportJob(db, jobId, {}))
})

sseRoutes.get('/:exportJobId/download', async (c) => {
  const db = c.var.db
  const job = getExportJobById(db, c.req.param('exportJobId'))
  if (!job) {
    return c.json({ error: 'not found' }, 404)
  }
  if (job.status !== 'succeeded' || !job.outputPath) {
    return c.json({ error: 'not ready' }, 400)
  }

  const { readFileSync, existsSync } = await import('node:fs')
  if (!existsSync(job.outputPath)) {
    return c.json({ error: 'output file not found' }, 404)
  }

  const file = readFileSync(job.outputPath)
  return c.body(file, 200, {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `attachment; filename="export-${job.id}.mp4"`,
  })
})

// Recover incomplete jobs on startup
function recoverIncompleteJobs() {
  const dbUrl = process.env.DATABASE_URL ?? 'data/edit-vid2.db'
  import('#/db').then(({ getDatabase }) => {
    const db = getDatabase(dbUrl)
    const incomplete = getIncompleteJobs(db)
    for (const job of incomplete) {
      if (job.status === 'running') {
        updateExportJob(db, job.id, { status: 'failed' })
      }
      if (job.status === 'canceling') {
        updateExportJob(db, job.id, { status: 'canceled' })
      }
    }
  })
}
recoverIncompleteJobs()

export { exportRoutes, sseRoutes }
