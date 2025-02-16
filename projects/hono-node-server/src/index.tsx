import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'

const app = new Hono()
app.use('/static/*', serveStatic({ root: '.' }))

app.get('/', (c) => {
  return c.html(
    <html>
      <head>
        <title>Hono Node Server</title>
      </head>
      <body>
        <h1>Hono Node Server</h1>
        <a href="/static/sample.txt">sample.txt</a>
      </body>
    </html>)
})

const port = 3000
console.log(`Server is running on http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port
})
