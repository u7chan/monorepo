import { serve } from '@hono/node-server'

import app from './app'

serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`Dev Server is running on http://localhost:${info.port}`)
})
