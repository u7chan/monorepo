import { createMiddleware } from 'hono/factory'
import type { HonoEnv } from '#/server/routes/shared'
import { getSignedInEmail } from '#/server/routes/shared'

export const requireAuth = createMiddleware<HonoEnv>(async (c, next) => {
  const email = await getSignedInEmail(c)
  if (!email) {
    return c.json({ error: 'Authentication error' }, 401)
  }
  c.set('email', email)
  await next()
})
