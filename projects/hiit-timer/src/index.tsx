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
      </head>
      <body class="min-h-screen flex flex-col items-center justify-center gap-6">
        <h1 class="text-3xl font-bold underline">Hello world!</h1>
        <div class="mt-6">
          <button
            class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 hover:shadow-md transform hover:scale-105 transition ease-in-out duration-150"
            hx-get="/time"
            hx-target="#result"
            hx-swap="innerHTML"
          >
            現在時刻を取得
          </button>
        </div>
        <div id="result" class="mt-4 text-lg">
          現在時刻: {new Date().toLocaleTimeString()}
        </div>
      </body>
    </html>
  )
})

app.get('/time', (c) => {
  const now = new Date().toLocaleTimeString()
  return c.html(`<div>現在時刻: ${now}</div>`)
})

export default app
