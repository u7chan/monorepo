import { Hono } from 'hono'
import { pinoLogger } from 'hono-pino'
import { logger } from './lib/logger'
import { AuthenticationError, authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { conversationsRoutes } from './routes/conversations'
import { htmlRoutes } from './routes/html'
import { modelsRoutes } from './routes/models'
import type { HonoEnv } from './routes/shared'

const app = new Hono<HonoEnv>().use(pinoLogger({ pino: logger })).onError((err, c) => {
  if (err instanceof AuthenticationError) {
    return c.json({ error: err.message }, 401)
  }

  logger.error({ err }, 'Unhandled error')
  return c.json({ error: err.message }, 500)
})
const routes = app
  .route('/', authRoutes)
  .route('/', chatRoutes)
  .route('/', conversationsRoutes)
  .route('/', modelsRoutes)
  .route('/', htmlRoutes)

export type AppType = typeof routes
export default app
