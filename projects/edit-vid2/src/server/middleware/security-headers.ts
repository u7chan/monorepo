import type { Context } from 'hono'

export function applySecurityHeaders(c: Context, next: () => Promise<void>) {
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  return next()
}
