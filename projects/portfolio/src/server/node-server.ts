import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'

import app from './app'

const port = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 3000
console.log(`Server is running on http://localhost:${port}`)

const hono = new Hono()
hono.use('/static/*', serveStatic({ root: './dist' }))
hono.route('/', app)

serve({
  fetch: hono.fetch,
  port,
})
