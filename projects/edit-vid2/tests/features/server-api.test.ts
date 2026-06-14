import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { exportJobs, projects, videoAssets } from '#/db/schema'
import { errHandler } from '#/server/middleware/error-handler'
import { recoverIncompleteJobs, removeExportFiles } from '#/server/routes/exports'
import { createTestServer, seedExportJob, seedProject, seedTemplate, seedVideoAsset } from './server-test-helper'

function jsonRequest(method: string, body: unknown) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('server API routes', () => {
  test('videos list and detail exclude soft-deleted records', async () => {
    const { app, db, cleanup } = createTestServer()
    try {
      seedVideoAsset(db, { id: 'active-video' })
      seedVideoAsset(db, { id: 'deleted-video', deletedAt: new Date().toISOString() })

      const listRes = await app.request('/api/videos')
      expect(listRes.status).toBe(200)
      const videos = await listRes.json()
      expect(videos.map((video: { id: string }) => video.id)).toEqual(['active-video'])

      const deletedRes = await app.request('/api/videos/deleted-video')
      expect(deletedRes.status).toBe(404)
    } finally {
      cleanup()
    }
  })

  test('video upload validates file presence, MIME type, and max size', async () => {
    const { app, cleanup } = createTestServer({
      videoRoutes: {
        getMaxUploadBytes: () => 4,
        writeVideoFile: async () => {},
      },
    })
    try {
      const missingFileRes = await app.request('/api/videos', { method: 'POST', body: new FormData() })
      expect(missingFileRes.status).toBe(400)

      const unsupported = new FormData()
      unsupported.set('file', new File(['abc'], 'note.txt', { type: 'text/plain' }))
      const unsupportedRes = await app.request('/api/videos', { method: 'POST', body: unsupported })
      expect(unsupportedRes.status).toBe(400)

      const tooLarge = new FormData()
      tooLarge.set('file', new File(['abcde'], 'movie.mp4', { type: 'video/mp4' }))
      const tooLargeRes = await app.request('/api/videos', { method: 'POST', body: tooLarge })
      expect(tooLargeRes.status).toBe(413)
    } finally {
      cleanup()
    }
  })

  test('video upload stores a processing record and can complete probing through injected deps', async () => {
    const scheduled: Promise<void>[] = []
    const { app, db, cleanup } = createTestServer({
      videoRoutes: {
        createId: () => 'video-new',
        getMaxUploadBytes: () => 100,
        getVideoDir: (id) => `/tmp/${id}`,
        ensureDir: () => {},
        writeVideoFile: async () => {},
        probeVideo: async () => ({
          duration: 12,
          width: 1280,
          height: 720,
          fps: 30,
          codec: 'h264',
          hasAudio: true,
          fileSize: 5,
        }),
        generateThumbnail: async () => true,
        scheduleVideoProcessing: (task) => {
          scheduled.push(task())
        },
      },
    })
    try {
      const form = new FormData()
      form.set('file', new File(['mp4'], 'movie.mp4', { type: 'video/mp4' }))
      form.set('displayName', 'Uploaded')

      const res = await app.request('/api/videos', { method: 'POST', body: form })
      expect(res.status).toBe(201)
      const created = await res.json()
      expect(created.id).toBe('video-new')
      expect(created.status).toBe('processing')
      expect(created.displayName).toBe('Uploaded')

      await Promise.all(scheduled)
      const updated = db.select().from(videoAssets).where(eq(videoAssets.id, 'video-new')).get()
      expect(updated?.status).toBe('ready')
      expect(updated?.width).toBe(1280)
      expect(updated?.height).toBe(720)
      expect(updated?.thumbnailPath).toBe('/tmp/video-new/thumbnail.jpg')
    } finally {
      cleanup()
    }
  })

  test('projects require a ready video asset and support duplicate/delete', async () => {
    const { app, db, cleanup } = createTestServer({
      projectRoutes: {
        createId: (() => {
          const ids = ['project-new', 'project-copy']
          return () => ids.shift() ?? 'project-extra'
        })(),
      },
    })
    try {
      seedVideoAsset(db, { id: 'ready-video', status: 'ready' })
      seedVideoAsset(db, { id: 'processing-video', status: 'processing' })

      const invalidRes = await app.request(
        '/api/projects',
        jsonRequest('POST', { name: 'Project', videoAssetId: 'processing-video' })
      )
      expect(invalidRes.status).toBe(400)

      const createRes = await app.request(
        '/api/projects',
        jsonRequest('POST', { name: 'Project', videoAssetId: 'ready-video' })
      )
      expect(createRes.status).toBe(201)

      db.update(projects)
        .set({ timelineState: { version: 1, tracks: [], keepSegments: [] } })
        .where(eq(projects.id, 'project-new'))
        .run()

      const duplicateRes = await app.request('/api/projects/project-new/duplicate', jsonRequest('POST', {}))
      expect(duplicateRes.status).toBe(201)
      const duplicate = await duplicateRes.json()
      expect(duplicate.id).toBe('project-copy')
      expect(duplicate.name).toBe('Project (コピー)')
      expect(duplicate.timelineState).toEqual({ version: 1, tracks: [], keepSegments: [] })

      const deleteRes = await app.request('/api/projects/project-new', { method: 'DELETE' })
      expect(deleteRes.status).toBe(204)
      expect((await app.request('/api/projects/project-new')).status).toBe(404)
    } finally {
      cleanup()
    }
  })

  test('templates enforce validation boundaries and persist defaults', async () => {
    const { app, cleanup } = createTestServer({
      templateRoutes: { createId: () => 'template-new' },
    })
    try {
      expect((await app.request('/api/templates', jsonRequest('POST', { name: '' }))).status).toBe(400)
      expect((await app.request('/api/templates', jsonRequest('POST', { name: 'x', fontSize: 0 }))).status).toBe(400)
      expect(
        (await app.request('/api/templates', jsonRequest('POST', { name: 'x', backgroundBoxOpacity: 1.01 }))).status
      ).toBe(400)

      const validRes = await app.request(
        '/api/templates',
        jsonRequest('POST', { name: 'a'.repeat(255), backgroundBoxOpacity: 1 })
      )
      expect(validRes.status).toBe(201)
      const template = await validRes.json()
      expect(template.id).toBe('template-new')
      expect(template.name).toBe('a'.repeat(255))
      expect(template.fontSize).toBe(48)
      expect(template.backgroundBoxOpacity).toBe(1)
    } finally {
      cleanup()
    }
  })

  test('preview route handles cache hit, generation success, and generation failure', async () => {
    for (const scenario of ['cached', 'generated', 'failed'] as const) {
      const generatedPaths: string[] = []
      const { app, db, cleanup } = createTestServer({
        previewRoutes: {
          exists: (path) => scenario === 'cached' && path.endsWith('.jpg'),
          ensureDir: () => {},
          getCacheDir: () => '/tmp/previews',
          generateSubtitlePreview: async ({ outputPath }) => {
            generatedPaths.push(outputPath)
            return scenario !== 'failed'
          },
        },
      })
      try {
        seedVideoAsset(db)
        seedProject(db)
        seedTemplate(db)

        const res = await app.request(
          '/api/projects/project-1/previews/subtitle',
          jsonRequest('POST', { sourceTime: 1, text: 'hello', templateId: 'template-1' })
        )
        expect(res.status).toBe(scenario === 'failed' ? 500 : 200)
        if (scenario !== 'failed') {
          expect((await res.json()).cached).toBe(scenario === 'cached')
        }
        expect(generatedPaths).toHaveLength(scenario === 'cached' ? 0 : 1)
      } finally {
        cleanup()
      }
    }
  })

  test('exports create jobs only for ready projects and enqueue once', async () => {
    const enqueued: string[] = []
    const { app, db, cleanup } = createTestServer({
      exportRoutes: {
        createId: () => 'job-new',
        worker: {
          enqueue: (jobId) => enqueued.push(jobId),
          cancel: () => {},
          onProgress: () => () => {},
        },
      },
    })
    try {
      seedVideoAsset(db)
      seedProject(db)

      const invalidPresetRes = await app.request(
        '/api/projects/project-1/export-jobs',
        jsonRequest('POST', { preset: { crf: 52 } })
      )
      expect(invalidPresetRes.status).toBe(400)

      const createRes = await app.request(
        '/api/projects/project-1/export-jobs',
        jsonRequest('POST', { preset: { crf: 0 } })
      )
      expect(createRes.status).toBe(201)
      expect(enqueued).toEqual(['job-new'])

      const missingProjectRes = await app.request('/api/projects/missing/export-jobs', jsonRequest('POST', {}))
      expect(missingProjectRes.status).toBe(404)
    } finally {
      cleanup()
    }
  })

  test('job list clamps limit and job actions follow status transitions', async () => {
    const canceled: string[] = []
    const removed: string[] = []
    const { app, db, cleanup } = createTestServer({
      jobRoutes: {
        worker: {
          enqueue: () => {},
          cancel: (jobId) => canceled.push(jobId),
          onProgress: () => () => {},
        },
        removeExportFiles: (jobId) => removed.push(jobId),
      },
    })
    try {
      seedVideoAsset(db)
      seedProject(db)
      seedExportJob(db, { id: 'queued-job', status: 'queued' })
      seedExportJob(db, { id: 'running-job', status: 'running' })
      seedExportJob(db, { id: 'succeeded-job', status: 'succeeded' })
      seedExportJob(db, { id: 'failed-job', status: 'failed' })

      const limitRes = await app.request('/api/export-jobs?limit=1')
      expect(limitRes.status).toBe(200)
      expect(await limitRes.json()).toHaveLength(1)

      const cancelRes = await app.request('/api/export-jobs/queued-job/cancel', { method: 'POST' })
      expect(cancelRes.status).toBe(200)
      expect(canceled).toEqual(['queued-job'])
      expect((await cancelRes.json()).status).toBe('canceled')

      const deleteRunningRes = await app.request('/api/export-jobs/running-job', { method: 'DELETE' })
      expect(deleteRunningRes.status).toBe(409)

      const deleteQueuedRes = await app.request('/api/export-jobs/queued-job', { method: 'DELETE' })
      expect(deleteQueuedRes.status).toBe(204)

      const deleteSucceededRes = await app.request('/api/export-jobs/succeeded-job', { method: 'DELETE' })
      expect(deleteSucceededRes.status).toBe(204)
      expect(removed).toEqual(['queued-job', 'succeeded-job'])
    } finally {
      cleanup()
    }
  })

  test('download and preview return expected statuses for files and ranges', async () => {
    const bytes = new Uint8Array(2048).fill(1)
    const { app, db, cleanup } = createTestServer({
      jobRoutes: {
        exists: (path) => path === '/tmp/export.mp4',
        readFile: () => bytes,
        stat: () => ({ size: bytes.length }),
        createReadStream: () => Readable.from(bytes),
      },
    })
    try {
      seedVideoAsset(db)
      seedProject(db)
      seedExportJob(db, { id: 'ready-job', status: 'succeeded', outputPath: '/tmp/export.mp4' })
      seedExportJob(db, { id: 'missing-file-job', status: 'succeeded', outputPath: '/tmp/missing.mp4' })

      expect((await app.request('/api/export-jobs/ready-job/download')).status).toBe(200)
      expect((await app.request('/api/export-jobs/missing-file-job/download')).status).toBe(404)

      const rangeRes = await app.request('/api/export-jobs/ready-job/preview', { headers: { Range: 'bytes=0-1023' } })
      expect(rangeRes.status).toBe(206)
      expect(rangeRes.headers.get('content-range')).toBe('bytes 0-1023/2048')

      const openRangeRes = await app.request('/api/export-jobs/ready-job/preview', {
        headers: { Range: 'bytes=1024-' },
      })
      expect(openRangeRes.status).toBe(206)
      expect(openRangeRes.headers.get('content-range')).toBe('bytes 1024-2047/2048')

      const invalidRangeRes = await app.request('/api/export-jobs/ready-job/preview', {
        headers: { Range: 'bytes=2048-2048' },
      })
      expect(invalidRangeRes.status).toBe(416)
    } finally {
      cleanup()
    }
  })

  test('recoverIncompleteJobs converts running and canceling jobs only', () => {
    const { db, cleanup } = createTestServer()
    try {
      seedVideoAsset(db)
      seedProject(db)
      seedExportJob(db, { id: 'queued-job', status: 'queued' })
      seedExportJob(db, { id: 'running-job', status: 'running' })
      seedExportJob(db, { id: 'canceling-job', status: 'canceling' })

      recoverIncompleteJobs({ db })

      const rows = db.select().from(exportJobs).all()
      expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
        'queued-job': 'queued',
        'running-job': 'failed',
        'canceling-job': 'canceled',
      })
    } finally {
      cleanup()
    }
  })

  test('middleware sets security headers and error handler returns JSON without stack', async () => {
    const { app, cleanup } = createTestServer()
    const originalError = console.error
    try {
      const res = await app.request('/api/videos')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('DENY')

      console.error = () => {}
      const errorRes = errHandler(new Error('boom'), {
        json: (body: unknown, status: number) => Response.json(body, { status }),
      } as Parameters<typeof errHandler>[1])
      expect(errorRes.status).toBe(500)
      expect(await errorRes.json()).toEqual({ error: 'boom' })
    } finally {
      console.error = originalError
      cleanup()
    }
  })

  test('removeExportFiles rejects traversal-like job ids', () => {
    let message = ''
    try {
      removeExportFiles('../outside', () => {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('invalid export path')
  })
})
