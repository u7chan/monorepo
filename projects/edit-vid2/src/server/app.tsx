import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { getDatabase } from '#/db'
import type { AppDatabase } from '#/db'
import { errHandler } from '#/server/middleware/error-handler'
import { applySecurityHeaders } from '#/server/middleware/security-headers'
import { exportRoutes, jobRoutes, recoverIncompleteJobs } from '#/server/routes/exports'
import { htmlRoutes } from '#/server/routes/html'
import { previewRoutes } from '#/server/routes/previews'
import { projectRoutes } from '#/server/routes/projects'
import { templateRoutes } from '#/server/routes/templates'
import { videoRoutes } from '#/server/routes/videos'

export type AppType = typeof routes

let db: AppDatabase | null = null

function getOrCreateDb() {
  if (!db) {
    const dbPath = process.env.DATABASE_URL ?? 'data/edit-vid2.db'
    db = getDatabase(dbPath)
  }
  return db
}

const app = new Hono<{
  Variables: {
    db: AppDatabase
  }
}>()
  .use(applySecurityHeaders)
  .onError(errHandler)
  .use('*', async (c, next) => {
    c.set('db', getOrCreateDb())
    await next()
  })

const routes = app
  .get('/data/*', serveStatic({ root: './' }))
  .route('/api/videos', videoRoutes)
  .route('/api/projects', projectRoutes)
  .route('/api/templates', templateRoutes)
  .route('/api/projects/:projectId/previews/subtitle', previewRoutes)
  .route('/api/projects/:projectId/export-jobs', exportRoutes)
  .route('/api/export-jobs', jobRoutes)
  .route('/', htmlRoutes)

recoverIncompleteJobs()

export default app
