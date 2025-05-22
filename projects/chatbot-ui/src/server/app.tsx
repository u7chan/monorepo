import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'

import type { Env } from '#/server/env'
import { renderer } from '#/server/renderer'

const app = new Hono<Env>()
app.use(logger())
app.use('/static/*', serveStatic({ root: './dist' }))
app.use(renderer)

app.post('/api/chat', async (c) => {
  const { message } = await c.req.json()
  await new Promise((resolve) => setTimeout(resolve, 3000)) // Simulate a delay
  return c.text(`${message}とご質問ありがとうございます。\nどのようにお手伝いできますか？`)
})

app.get('/', (c) => {
  return c.render(<div id='root' />)
})

export default app
