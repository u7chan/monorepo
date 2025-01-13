import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.html(
    <html>
      <head>
        <title>Page Title</title>
      </head>
      <body>
        <h1>This is a Heading</h1>
        <p>This is a paragraph.</p>
      </body>
    </html>)
})

const port = 3000
console.log(`Server is running on http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port
})
