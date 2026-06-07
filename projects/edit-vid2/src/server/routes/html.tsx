import { Hono } from 'hono'
import { env } from 'hono/adapter'

const htmlRoute = new Hono()

htmlRoute.get('*', (c) => {
  const { NODE_ENV } = env<{ NODE_ENV?: string }>(c)
  const prod = NODE_ENV === 'production'

  const cssHref = prod ? '/static/main.css' : '/src/client/main.css'
  const jsSrc = prod ? '/static/client.js' : '/src/client/main.tsx'

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>edit-vid2</title>
  <link rel="icon" href="${prod ? '/static/favicon.ico' : '/favicon.ico'}" />
  <link rel="stylesheet" href="${cssHref}" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${jsSrc}"></script>
</body>
</html>`)
})

export { htmlRoute as htmlRoutes }
