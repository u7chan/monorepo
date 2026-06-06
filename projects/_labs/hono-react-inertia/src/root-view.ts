import { serializePage, type RootView } from "@hono/inertia"

export const rootView: RootView = (page) => `<!DOCTYPE html>
<html>
  <head>
    <title>App</title>
    <script type="module" src="/static/client.js"></script>
  </head>
  <body>
    <script data-page="app" type="application/json">${serializePage(page)}</script>
    <div id="app"></div>
  </body>
</html>`
