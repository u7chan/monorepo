import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import app from './app'
import { logger } from './lib/logger'

const port = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 3000
logger.info({ port }, 'Server is running')

const hono = new Hono()
hono.use('/static/*', serveStatic({ root: './dist' }))
hono.route('/', app)

serve({
  fetch: hono.fetch,
  port,
})
