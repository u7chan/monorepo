import { structuredLogger } from '@hono/structured-logger'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import type pino from 'pino'
import { logger } from './lib/logger'
import { AuthenticationError, authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { conversationsRoutes } from './routes/conversations'
import { htmlRoutes } from './routes/html'
import { modelsRoutes } from './routes/models'
import type { HonoEnv } from './routes/shared'

const app = new Hono<HonoEnv>()
  .use(requestId())
  .use(
    structuredLogger<pino.Logger>({
      createLogger: (c) => logger.child({ requestId: c.var.requestId }),
      onRequest: (requestLogger, c) => {
        requestLogger.info(
          {
            req: {
              method: c.req.method,
              url: c.req.path,
              headers: c.req.header(),
            },
          },
          'request start'
        )
      },
      onResponse: (requestLogger, c, elapsedMs) => {
        requestLogger.info(
          {
            req: {
              method: c.req.method,
              url: c.req.path,
            },
            res: {
              status: c.res.status,
            },
            responseTime: Math.round(elapsedMs),
          },
          'request end'
        )
      },
      onError: (requestLogger, err, c) => {
        const bindings = {
          err,
          req: {
            method: c.req.method,
            url: c.req.path,
          },
          res: {
            status: c.res.status,
          },
        }

        if (err instanceof AuthenticationError) {
          requestLogger.warn(bindings, 'request unauthorized')
          return
        }

        requestLogger.error(bindings, 'request error')
      },
    })
  )
  .onError((err, c) => {
    if (err instanceof AuthenticationError) {
      return c.json({ error: err.message }, 401)
    }

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
