import { Hono } from 'hono'
import { getSystemStatus } from '#/server/features/system-status/system-status'
import { requireAuth } from '#/server/middleware/auth'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const systemStatusRoutes = new Hono<HonoEnv>().get('/api/system-status', requireAuth, async (c) => {
  c.header('Cache-Control', 'no-store')

  try {
    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true'
    const status = await getSystemStatus(getServerEnv(c), { force: refresh })

    return c.json(status)
  } catch {
    return c.json({ error: 'System status unavailable' }, 503)
  }
})

export { systemStatusRoutes }
