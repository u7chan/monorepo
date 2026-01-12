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
        <title>hiit-timer</title>
        <script src="/static/htmx.2.0.8.js"></script>
        <script src="/static/tailwindcss.4.1.18.js"></script>
        <script src="/static/client.js" type="module"></script>
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  )
})

app.get('/time', (c) => {
  const now = new Date().toLocaleTimeString()
  return c.html(`<div>現在時刻: ${now}</div>`)
})

export default app
