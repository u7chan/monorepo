import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'

import server from './server'

const app = new Hono()
app.use('/static/*', serveStatic({ root: './dist' }))

app.route('/', server)

const port = 3000

console.log(`Server is running on http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port,
})
