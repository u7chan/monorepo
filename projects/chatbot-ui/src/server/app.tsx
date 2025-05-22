import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { streamText } from 'hono/streaming'

import type { Env } from '#/server/env'
import { renderer } from '#/server/renderer'
import { delay } from './utils/delay'

const app = new Hono<Env>()
app.use(logger())
app.use('/static/*', serveStatic({ root: './dist' }))
app.use(renderer)

app.post('/api/chat', async (c) => {
  const { message } = await c.req.json()
  await delay(3000)
  return streamText(c, async (stream) => {
    stream.writeln('こん\nにちは！')
    await delay(1000)
    stream.writeln(`「${message}」とご質問ありがとうございます。`)
    await delay(1000)
    stream.writeln('お待たせしました！')
    await delay(1000)
    stream.writeln('どのようにお手伝いできますか？')
  })
})

app.get('/', (c) => {
  return c.render(<div id='root' />)
})

export default app
