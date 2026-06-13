import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Hono } from 'hono'
import { getDatabase } from '#/db'
import { exportJobs, projects, videoAssets } from '#/db/schema'
import { jobRoutes } from '#/server/routes/exports'

const fixturePath = 'tests/fixtures/test-compat.mp4'

function createTestApp() {
  const dbPath = join(tmpdir(), `edit-vid2-preview-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = getDatabase(dbPath)
  migrate(db, { migrationsFolder: './drizzle' })

  const app = new Hono<{ Variables: { db: typeof db } }>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/', jobRoutes)

  db.insert(videoAssets)
    .values({
      id: 'video-1',
      originalFilename: 'test.mp4',
      displayName: 'Test Video',
      storagePath: 'data/videos/video-1/source.mp4',
      status: 'ready',
    })
    .run()

  db.insert(projects)
    .values({
      id: 'project-1',
      videoAssetId: 'video-1',
      name: 'Test Project',
    })
    .run()

  const exportDir = join(tmpdir(), `edit-vid2-preview-${Date.now()}`)
  mkdirSync(exportDir, { recursive: true })

  return { app, db, dbPath, exportDir }
}

function seedSucceededJob(db: ReturnType<typeof getDatabase>, exportDir: string, jobId: string) {
  copyFileSync(fixturePath, join(exportDir, `${jobId}.mp4`))
  db.insert(exportJobs)
    .values({
      id: jobId,
      projectId: 'project-1',
      status: 'succeeded',
      outputPath: join(exportDir, `${jobId}.mp4`),
    })
    .run()
}

function cleanup(exportDir: string, dbPath: string) {
  try {
    rmSync(exportDir, { recursive: true, force: true })
  } catch {}
  try {
    rmSync(dbPath)
  } catch {}
}

describe('export preview API', () => {
  test('returns 200 inline video/mp4 without range', async () => {
    const { app, db, dbPath, exportDir } = createTestApp()
    try {
      seedSucceededJob(db, exportDir, 'job-1')
      const res = await app.request('/job-1/preview')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      expect(res.headers.get('content-disposition')).toBe('inline; filename="export-job-1.mp4"')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
    } finally {
      cleanup(exportDir, dbPath)
    }
  })

  test('returns 206 partial content with valid range', async () => {
    const { app, db, dbPath, exportDir } = createTestApp()
    try {
      seedSucceededJob(db, exportDir, 'job-1')
      const res = await app.request('/job-1/preview', {
        headers: { Range: 'bytes=0-1023' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      const contentRange = res.headers.get('content-range')
      expect(contentRange).toContain('bytes 0-1023/')
      expect(res.headers.get('content-length')).toBe('1024')
    } finally {
      cleanup(exportDir, dbPath)
    }
  })

  test('returns 404 for missing job', async () => {
    const { app, dbPath, exportDir } = createTestApp()
    try {
      const res = await app.request('/missing/preview')
      expect(res.status).toBe(404)
    } finally {
      cleanup(exportDir, dbPath)
    }
  })

  test('returns 400 for unfinished job', async () => {
    const { app, db, dbPath, exportDir } = createTestApp()
    try {
      db.insert(exportJobs)
        .values({
          id: 'job-2',
          projectId: 'project-1',
          status: 'running',
          outputPath: null,
        })
        .run()
      const res = await app.request('/job-2/preview')
      expect(res.status).toBe(400)
    } finally {
      cleanup(exportDir, dbPath)
    }
  })

  test('returns 404 for missing output file', async () => {
    const { app, db, dbPath, exportDir } = createTestApp()
    try {
      db.insert(exportJobs)
        .values({
          id: 'job-3',
          projectId: 'project-1',
          status: 'succeeded',
          outputPath: join(exportDir, 'missing.mp4'),
        })
        .run()
      const res = await app.request('/job-3/preview')
      expect(res.status).toBe(404)
    } finally {
      cleanup(exportDir, dbPath)
    }
  })

  test('returns 416 for invalid range', async () => {
    const { app, db, dbPath, exportDir } = createTestApp()
    try {
      seedSucceededJob(db, exportDir, 'job-1')
      const res = await app.request('/job-1/preview', {
        headers: { Range: 'bytes=99999999-99999999' },
      })
      expect(res.status).toBe(416)
    } finally {
      cleanup(exportDir, dbPath)
    }
  })
})
