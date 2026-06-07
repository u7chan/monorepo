import { getDatabase } from '#/db'
import { applySecurityHeaders } from '#/server/middleware/security-headers'
import { errHandler } from '#/server/middleware/error-handler'
import { exportRoutes, sseRoutes } from '#/server/routes/exports'
import { htmlRoutes } from '#/server/routes/html'
import { previewRoutes } from '#/server/routes/previews'
import { projectRoutes } from '#/server/routes/projects'
import { templateRoutes } from '#/server/routes/templates'
import { videoRoutes } from '#/server/routes/videos'
import type { AppDatabase } from '#/db'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'

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

app.use('/static/*', serveStatic({ root: './dist' }))
app.route('/', htmlRoutes)
app.route('/api/videos', videoRoutes)
app.route('/api/projects', projectRoutes)
app.route('/api/templates', templateRoutes)
app.route('/api/projects/:projectId/previews/subtitle', previewRoutes)
app.route('/api/projects/:projectId/export-jobs', exportRoutes)
app.route('/api/export-jobs', sseRoutes)

const port = Number(process.env.SERVER_PORT) || 3000

const { serve } = await import('@hono/node-server')
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`edit-vid2 server running on port ${info.port}`)
})
