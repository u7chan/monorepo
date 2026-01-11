import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

const app = new Hono()
app.use('/static/*', serveStatic({ root: './' }))

app.get('/', (c) => {
  return c.html(
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="/static/tailwindcss.4.1.18.js"></script>
      </head>
      <body>
        <h1 class="text-3xl font-bold underline">Hello world!</h1>
      </body>
    </html>
  )
})

export default app
