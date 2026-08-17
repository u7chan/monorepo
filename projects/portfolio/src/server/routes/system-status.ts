import { Hono } from 'hono'
import { getSystemStatus, toPublicSystemStatus } from '#/server/features/system-status/system-status'
import { PublicSystemStatusSchema } from '#/types/system-status'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const systemStatusRoutes = new Hono<HonoEnv>().get('/api/system-status', async (c) => {
  c.header('Cache-Control', 'no-store')

  try {
    const status = await getSystemStatus(getServerEnv(c))

    return c.json(PublicSystemStatusSchema.parse(toPublicSystemStatus(status)), 200)
  } catch {
    return c.json({ error: 'System status unavailable' }, 503)
  }
})

export { systemStatusRoutes }
