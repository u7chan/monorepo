import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serveStatic } from 'hono/bun'
import { getDatabase } from '#/db'
import type { AppDatabase } from '#/db'
import { errHandler } from '#/server/middleware/error-handler'
import { applySecurityHeaders } from '#/server/middleware/security-headers'
import { createExportRoutes, createJobRoutes } from '#/server/routes/exports'
import { htmlRoutes } from '#/server/routes/html'
import { createPreviewRoutes } from '#/server/routes/previews'
import { createProjectRoutes } from '#/server/routes/projects'
import { createTemplateRoutes } from '#/server/routes/templates'
import { createVideoRoutes } from '#/server/routes/videos'

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function serveDataFile(c: Context) {
  const url = new URL(c.req.url)
  const filePath = resolve(process.cwd(), `.${url.pathname}`)

  if (!existsSync(filePath)) {
    return c.notFound()
  }

  const { size } = statSync(filePath)
  const ext = extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const rangeHeader = c.req.header('range')

  if (!rangeHeader) {
    const stream = createReadStream(filePath)
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200, {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    })
  }

  const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/)
  if (!match) {
    return c.body('range not satisfiable', 416)
  }

  const start = Number.parseInt(match[1], 10)
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1

  if (Number.isNaN(start) || Number.isNaN(end) || start >= size || end >= size || start > end) {
    return c.body('range not satisfiable', 416)
  }

  const length = end - start + 1
  const stream = createReadStream(filePath, { start, end })

  return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 206, {
    'Content-Type': contentType,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
  })
}

type AppDeps = {
  db?: AppDatabase
  getDb?: () => AppDatabase
  videoRoutes?: Parameters<typeof createVideoRoutes>[0]
  projectRoutes?: Parameters<typeof createProjectRoutes>[0]
  templateRoutes?: Parameters<typeof createTemplateRoutes>[0]
  previewRoutes?: Parameters<typeof createPreviewRoutes>[0]
  exportRoutes?: Parameters<typeof createExportRoutes>[0]
  jobRoutes?: Parameters<typeof createJobRoutes>[0]
}

let db: AppDatabase | null = null

function getOrCreateDb() {
  if (!db) {
    const dbPath = process.env.DATABASE_URL ?? 'data/edit-vid2.db'
    db = getDatabase(dbPath)
  }
  return db
}

function createApp(deps: AppDeps = {}) {
  const getDb = deps.getDb ?? (() => deps.db ?? getOrCreateDb())

  const app = new Hono<{
    Variables: {
      db: AppDatabase
    }
  }>()
    .use(applySecurityHeaders)
    .onError(errHandler)
    .use('*', async (c, next) => {
      c.set('db', getDb())
      await next()
    })

  return app
    .get('/static/*', serveStatic({ root: './dist' }))
    .get('/data/*', serveDataFile)
    .route('/api/videos', createVideoRoutes(deps.videoRoutes))
    .route('/api/projects', createProjectRoutes(deps.projectRoutes))
    .route('/api/templates', createTemplateRoutes(deps.templateRoutes))
    .route('/api/projects/:projectId/previews', createPreviewRoutes(deps.previewRoutes))
    .route('/api/projects/:projectId/export-jobs', createExportRoutes(deps.exportRoutes))
    .route('/api/export-jobs', createJobRoutes(deps.jobRoutes))
    .route('/', htmlRoutes)
}

const app = createApp()

export type AppType = typeof app
export { createApp }

export default app
