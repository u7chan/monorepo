import { structuredLogger } from '@hono/structured-logger'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { requestId } from 'hono/request-id'
import type pino from 'pino'
import { resolveFileServerPublicOrigin } from './features/chat-conversations/file-server-client'
import { getErrorMessage } from './lib/error-message'
import { logger } from './lib/logger'
import { AuthenticationError, authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { conversationsRoutes } from './routes/conversations'
import { htmlRoutes } from './routes/html'
import { modelsRoutes } from './routes/models'
import { promptTemplatesRoutes } from './routes/prompt-templates'
import type { HonoEnv } from './routes/shared'
import { getServerEnv } from './routes/shared'

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()',
} as const

function buildContentSecurityPolicy(fileServerPublicOrigin: string | null): string {
  const imageOrigin = fileServerPublicOrigin ? ` ${fileServerPublicOrigin}` : ''

  return `base-uri 'self'; default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data: https:${imageOrigin}; connect-src 'self'; frame-src 'self'`
}

const applySecurityHeaders: MiddlewareHandler<HonoEnv> = async (c, next) => {
  await next()

  c.header('Content-Security-Policy', buildContentSecurityPolicy(resolveFileServerPublicOrigin(getServerEnv(c))))
  for (const [name, value] of Object.entries(securityHeaders)) {
    c.header(name, value)
  }
}

const app = new Hono<HonoEnv>()
  .use(requestId())
  .use(applySecurityHeaders)
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
      return c.json({ error: getErrorMessage(err, 'Authentication error') }, 401)
    }

    return c.json({ error: getErrorMessage(err, 'Internal Server Error') }, 500)
  })
const routes = app
  .route('/', authRoutes)
  .route('/', chatRoutes)
  .route('/', conversationsRoutes)
  .route('/', modelsRoutes)
  .route('/', promptTemplatesRoutes)
  .route('/', htmlRoutes)

export type AppType = typeof routes
export default app
