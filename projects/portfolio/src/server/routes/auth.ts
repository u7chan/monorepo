import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { deleteCookie, setSignedCookie } from 'hono/cookie'
import { z } from 'zod'
import { AuthenticationError, auth } from '#/server/features/auth/auth'
import { cookie } from '#/server/features/cookie/cookie'
import { signinRateLimit } from '#/server/middleware/rate-limit'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const SignInBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})

const authRoutes = new Hono<HonoEnv>()
  .post('/api/signin', sValidator('json', SignInBodySchema), signinRateLimit, async (c) => {
    const { email, password } = c.req.valid('json')
    const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '', COOKIE_EXPIRES = '1d' } = getServerEnv(c)

    await auth.login(DATABASE_URL, email, password)
    await setSignedCookie(c, COOKIE_NAME, email, COOKIE_SECRET, cookie.createOptions(COOKIE_EXPIRES))

    return c.json({})
  })
  .post('/api/signout', async (c) => {
    const { COOKIE_NAME = '' } = getServerEnv(c)

    await auth.logout()
    if (COOKIE_NAME) {
      deleteCookie(c, COOKIE_NAME, { path: '/' })
    }

    return c.json({})
  })

export { AuthenticationError, authRoutes }
