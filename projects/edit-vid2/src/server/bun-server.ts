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
app.use('/data/*', serveStatic({ root: './' }))
app.route('/api/videos', videoRoutes)
app.route('/api/projects', projectRoutes)
app.route('/api/templates', templateRoutes)
app.route('/api/projects/:projectId/previews/subtitle', previewRoutes)
app.route('/api/projects/:projectId/export-jobs', exportRoutes)
app.route('/api/export-jobs', jobRoutes)
app.route('/', htmlRoutes)

const port = Number(process.env.SERVER_PORT) || 3000

Bun.serve({
  fetch: app.fetch,
  port,
})

recoverIncompleteJobs()

console.log(`edit-vid2 server running on port ${port}`)
