import type { Context } from 'hono'
import { env } from 'hono/adapter'
import { deleteCookie, getSignedCookie } from 'hono/cookie'
import type pino from 'pino'

export type Env = Partial<{
  NODE_ENV: string
  SERVER_PORT: string
  DATABASE_URL: string
  COOKIE_SECRET: string
  COOKIE_NAME: string
  COOKIE_EXPIRES: string
  LOG_LEVEL: string
  LOG_FILE: string
}>

export type HonoEnv = {
  Bindings: Env
  Variables: {
    email: string
    logger: pino.Logger
    requestId: string
  }
}

export const getServerEnv = (c: Context<HonoEnv>) => env<Env>(c)

export const getSignedInEmail = async (c: Context<HonoEnv>) => {
  const { COOKIE_SECRET = '', COOKIE_NAME = '' } = getServerEnv(c)
  const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)

  if (!email) {
    if (COOKIE_NAME) {
      deleteCookie(c, COOKIE_NAME)
    }
    return null
  }

  return email
}
