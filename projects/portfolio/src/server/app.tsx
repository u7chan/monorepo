import { Hono } from 'hono'
import { AuthenticationError, authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { conversationsRoutes } from './routes/conversations'
import { htmlRoutes } from './routes/html'
import { modelsRoutes } from './routes/models'
import type { HonoEnv } from './routes/shared'

const app = new Hono<HonoEnv>().onError((err, c) => {
  if (err instanceof AuthenticationError) {
    return c.json({ error: err.message }, 401)
  }

  console.error('Unknown Error', err)
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
