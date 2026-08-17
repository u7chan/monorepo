import { Hono } from 'hono'
import { getSystemStatus, toPublicSystemStatus } from '#/server/features/system-status/system-status'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const systemStatusRoutes = new Hono<HonoEnv>().get('/api/system-status', async (c) => {
  c.header('Cache-Control', 'no-store')

  try {
    const status = await getSystemStatus(getServerEnv(c))

    return c.json(toPublicSystemStatus(status))
  } catch {
    return c.json({ error: 'System status unavailable' }, 503)
  }
})

export { systemStatusRoutes }
