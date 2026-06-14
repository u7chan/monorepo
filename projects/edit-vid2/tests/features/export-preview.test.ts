import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppDatabase } from '#/db'
import { exportJobs } from '#/db/schema'
import { createTestServer, seedExportJob, seedProject, seedVideoAsset } from './server-test-helper'

const fixturePath = 'tests/fixtures/test-compat.mp4'

function createTestApp() {
  const server = createTestServer()
  seedVideoAsset(server.db)
  seedProject(server.db)
  const exportDir = join(tmpdir(), `edit-vid2-preview-${Date.now()}`)
  mkdirSync(exportDir, { recursive: true })
  return { ...server, exportDir }
}

function seedSucceededJob(db: AppDatabase, exportDir: string, jobId: string) {
  copyFileSync(fixturePath, join(exportDir, `${jobId}.mp4`))
  seedExportJob(db, {
    id: jobId,
    projectId: 'project-1',
    status: 'succeeded',
    outputPath: join(exportDir, `${jobId}.mp4`),
  })
}

function cleanup(exportDir: string, cleanupServer: () => void) {
  try {
    rmSync(exportDir, { recursive: true, force: true })
  } catch {}
  cleanupServer()
}

describe('export preview API', () => {
  test('returns 200 inline video/mp4 without range', async () => {
    const { app, db, cleanup: cleanupServer, exportDir } = createTestApp()
    try {
      seedSucceededJob(db, exportDir, 'job-1')
      const res = await app.request('/api/export-jobs/job-1/preview')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      expect(res.headers.get('content-disposition')).toBe('inline; filename="export-job-1.mp4"')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
    } finally {
      cleanup(exportDir, cleanupServer)
    }
  })

  test('returns 206 partial content with valid range', async () => {
    const { app, db, cleanup: cleanupServer, exportDir } = createTestApp()
    try {
      seedSucceededJob(db, exportDir, 'job-1')
      const res = await app.request('/api/export-jobs/job-1/preview', {
        headers: { Range: 'bytes=0-1023' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      const contentRange = res.headers.get('content-range')
      expect(contentRange).toContain('bytes 0-1023/')
      expect(res.headers.get('content-length')).toBe('1024')
    } finally {
      cleanup(exportDir, cleanupServer)
    }
  })

  test('returns 404 for missing job', async () => {
    const { app, cleanup: cleanupServer, exportDir } = createTestApp()
    try {
      const res = await app.request('/api/export-jobs/missing/preview')
      expect(res.status).toBe(404)
    } finally {
      cleanup(exportDir, cleanupServer)
    }
  })

  test('returns 400 for unfinished job', async () => {
    const { app, db, cleanup: cleanupServer, exportDir } = createTestApp()
    try {
      db.insert(exportJobs)
        .values({
          id: 'job-2',
          projectId: 'project-1',
          status: 'running',
          outputPath: null,
        })
        .run()
      const res = await app.request('/api/export-jobs/job-2/preview')
      expect(res.status).toBe(400)
    } finally {
      cleanup(exportDir, cleanupServer)
    }
  })

  test('returns 404 for missing output file', async () => {
    const { app, db, cleanup: cleanupServer, exportDir } = createTestApp()
    try {
      db.insert(exportJobs)
        .values({
          id: 'job-3',
          projectId: 'project-1',
          status: 'succeeded',
          outputPath: join(exportDir, 'missing.mp4'),
        })
        .run()
      const res = await app.request('/api/export-jobs/job-3/preview')
      expect(res.status).toBe(404)
    } finally {
      cleanup(exportDir, cleanupServer)
    }
  })

  test('returns 416 for invalid range', async () => {
    const { app, db, cleanup: cleanupServer, exportDir } = createTestApp()
    try {
      seedSucceededJob(db, exportDir, 'job-1')
      const res = await app.request('/api/export-jobs/job-1/preview', {
        headers: { Range: 'bytes=99999999-99999999' },
      })
      expect(res.status).toBe(416)
    } finally {
      cleanup(exportDir, cleanupServer)
    }
  })
})
