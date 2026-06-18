import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { getDatabase } from '#/db'
import type { AppDatabase } from '#/db'
import { errHandler } from '#/server/middleware/error-handler'
import { applySecurityHeaders } from '#/server/middleware/security-headers'
import { createDataFileRoutes, type DataFileRouteDeps } from '#/server/routes/data-files'
import { createExportRoutes, createJobRoutes } from '#/server/routes/exports'
import { htmlRoutes } from '#/server/routes/html'
import { createPreviewRoutes } from '#/server/routes/previews'
import { createProjectRoutes } from '#/server/routes/projects'
import { createTemplateRoutes } from '#/server/routes/templates'
import { createVideoRoutes } from '#/server/routes/videos'

type AppDeps = {
  db?: AppDatabase
  getDb?: () => AppDatabase
  videoRoutes?: Parameters<typeof createVideoRoutes>[0]
  projectRoutes?: Parameters<typeof createProjectRoutes>[0]
  templateRoutes?: Parameters<typeof createTemplateRoutes>[0]
  previewRoutes?: Parameters<typeof createPreviewRoutes>[0]
  exportRoutes?: Parameters<typeof createExportRoutes>[0]
  jobRoutes?: Parameters<typeof createJobRoutes>[0]
  dataFileRoutes?: Partial<DataFileRouteDeps>
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
  const dataFileDeps = deps.dataFileRoutes ?? {}

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
    .route('/', createDataFileRoutes(dataFileDeps))
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
