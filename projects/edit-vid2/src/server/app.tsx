import { getDatabase } from '#/db'
import { applySecurityHeaders } from '#/server/middleware/security-headers'
import { errHandler } from '#/server/middleware/error-handler'
import { htmlRoutes } from '#/server/routes/html'
import { videoRoutes } from '#/server/routes/videos'
import type { AppDatabase } from '#/db'
import { Hono } from 'hono'

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
  .route('/', htmlRoutes)
  .route('/api/videos', videoRoutes)

export default app
