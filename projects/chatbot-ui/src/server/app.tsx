import type { Env } from '@/server/env'
import { renderer } from '@/server/renderer'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'

const app = new Hono<Env>()
app.use(logger())
app.use('/static/*', serveStatic({ root: './dist' }))
app.use(renderer)

app.get('/api/health', (c) => {
  return c.json({
    status: 'OK',
  })
})

app.get('/', (c) => {
  return c.render(
    <>
      <p>Server Side Rendering: {new Date().toISOString()}</p>
      <div id='root' />
    </>,
  )
})

export default app
