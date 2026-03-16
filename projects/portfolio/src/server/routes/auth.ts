import { AuthenticationError, auth } from '#/server/features/auth/auth'
import { cookie } from '#/server/features/cookie/cookie'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { setSignedCookie } from 'hono/cookie'
import { z } from 'zod'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const SignInBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})

const authRoutes = new Hono<HonoEnv>().post('api/signin', sValidator('json', SignInBodySchema), async (c) => {
  const { email, password } = c.req.valid('json')
  const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '', COOKIE_EXPIRES = '1d' } = getServerEnv(c)

  await auth.login(DATABASE_URL, email, password)
  await setSignedCookie(c, COOKIE_NAME, email, COOKIE_SECRET, cookie.createOptions(COOKIE_EXPIRES))

  return c.json({})
})

export { AuthenticationError, authRoutes }
