import type { Context } from 'hono'
import { env } from 'hono/adapter'
import { deleteCookie, getSignedCookie } from 'hono/cookie'

export type Env = Partial<{
  NODE_ENV: string
  SERVER_PORT: string
  DATABASE_URL: string
  COOKIE_SECRET: string
  COOKIE_NAME: string
  COOKIE_EXPIRES: string
}>

export type HonoEnv = {
  Bindings: Env
}

export const getServerEnv = (c: Context<HonoEnv>) => env<Env>(c)

export const getSignedInEmail = async (c: Context<HonoEnv>) => {
  const { COOKIE_SECRET = '', COOKIE_NAME = '' } = getServerEnv(c)
  const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)

  if (!email) {
    deleteCookie(c, COOKIE_NAME)
    return null
  }

  return email
}
