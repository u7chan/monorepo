import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDataFileRoutes } from '#/server/routes/data-files'
import { createTestServer } from './server-test-helper'

function setupTempRoot() {
  const root = join(tmpdir(), `edit-vid2-data-files-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

describe('data file API', () => {
  test('returns 200 with full content and headers without range', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'source.mp4'), 'hello world')

      const res = await app.request('/data/videos/video-1/source.mp4')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      expect(res.headers.get('content-length')).toBe('11')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(await res.text()).toBe('hello world')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 206 for closed range', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'source.mp4'), 'hello world')

      const res = await app.request('/data/videos/video-1/source.mp4', {
        headers: { Range: 'bytes=0-3' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 0-3/11')
      expect(res.headers.get('content-length')).toBe('4')
      expect(await res.text()).toBe('hell')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 206 for open-ended range', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'source.mp4'), 'hello world')

      const res = await app.request('/data/videos/video-1/source.mp4', {
        headers: { Range: 'bytes=6-' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 6-10/11')
      expect(await res.text()).toBe('world')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 206 for suffix range', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'source.mp4'), 'hello world')

      const res = await app.request('/data/videos/video-1/source.mp4', {
        headers: { Range: 'bytes=-5' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 6-10/11')
      expect(await res.text()).toBe('world')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('clamps end beyond size to file end', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'source.mp4'), 'hello world')

      const res = await app.request('/data/videos/video-1/source.mp4', {
        headers: { Range: 'bytes=0-999999999' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 0-10/11')
      expect(await res.text()).toBe('hello world')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 416 with content-range header for invalid range', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'source.mp4'), 'hello world')

      const res = await app.request('/data/videos/video-1/source.mp4', {
        headers: { Range: 'bytes=11-11' },
      })
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */11')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 416 for empty file range request', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'source.mp4'), '')

      const res = await app.request('/data/videos/video-1/source.mp4', {
        headers: { Range: 'bytes=0-' },
      })
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */0')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 404 for missing file', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const res = await app.request('/data/videos/video-1/missing.mp4')
      expect(res.status).toBe(404)
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 404 for directory', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      mkdirSync(join(root, 'video-1'))
      const res = await app.request('/data/videos/video-1')
      expect(res.status).toBe(404)
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 400 for malformed percent encoding on video route', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const res = await app.request('/data/videos/%E0%A4%A')
      expect(res.status).toBe(400)
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns 404 for encoded path traversal', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      writeFileSync(join(root, 'secret.txt'), 'secret')
      const res = await app.request('/data/videos/%2e%2e%2fsecret.txt')
      expect(res.status).toBe(404)
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns octet-stream for unknown extension', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'video-1')
      mkdirSync(dir)
      writeFileSync(join(dir, 'data.unknown'), 'binary')

      const res = await app.request('/data/videos/video-1/data.unknown')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('serves project preview files under nested route', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const dir = join(root, 'project-1', 'previews')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'preview.jpg'), 'image')

      const res = await app.request('/data/projects/project-1/previews/preview.jpg')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/jpeg')
      expect(await res.text()).toBe('image')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('project preview is scoped to its own project directory', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const ownDir = join(root, 'project-1', 'previews')
      const otherDir = join(root, 'project-2', 'previews')
      mkdirSync(ownDir, { recursive: true })
      mkdirSync(otherDir, { recursive: true })
      writeFileSync(join(ownDir, 'preview.jpg'), 'image')
      writeFileSync(join(otherDir, 'preview.jpg'), 'other')

      const res = await app.request(
        '/data/projects/project-1/previews/' + encodeURIComponent('../project-2/previews/preview.jpg')
      )
      expect(res.status).toBe(404)
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('does not serve files outside allowed data roots', async () => {
    const root = setupTempRoot()
    const { app, cleanup } = createTestServer({ dataFileRoutes: { videoRoot: root, projectRoot: root } })
    try {
      const exportsDir = join(root, 'exports', 'job-1')
      mkdirSync(exportsDir, { recursive: true })
      writeFileSync(join(exportsDir, 'output.mp4'), 'video')

      const res = await app.request('/data/exports/job-1/output.mp4')
      expect(res.headers.get('content-type')).toBe('text/html; charset=UTF-8')
    } finally {
      cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('data file route security', () => {
  test('rejects encoded path traversal at route level', async () => {
    const root = setupTempRoot()
    const routes = createDataFileRoutes({ videoRoot: root, projectRoot: root })
    try {
      const res = await routes.request('/%2e%2e%2foutside.txt')
      expect(res.status).toBe(404)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
