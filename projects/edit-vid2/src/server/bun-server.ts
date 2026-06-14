import { createApp } from '#/server/app'
import { recoverIncompleteJobs } from '#/server/routes/exports'

const port = Number(process.env.SERVER_PORT) || 3000
const app = createApp()

Bun.serve({
  fetch: app.fetch,
  port,
})

recoverIncompleteJobs()

console.log(`edit-vid2 server running on port ${port}`)
