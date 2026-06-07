import type { Context } from 'hono'

export function errHandler(err: Error, c: Context) {
  console.error('[error]', err.message, err.stack)
  return c.json({ error: err.message }, 500)
}
