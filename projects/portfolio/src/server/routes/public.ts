import { resolveFileServerBaseUrl } from '#/server/features/chat-conversations/file-server-client'
import { Hono } from 'hono'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

function buildProxyRequestHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers(requestHeaders)
  headers.delete('host')
  headers.delete('cookie')
  return headers
}

export const publicRoutes = new Hono<HonoEnv>().on(['GET', 'HEAD'], '/public/*', async (c) => {
  const baseUrl = resolveFileServerBaseUrl(getServerEnv(c))

  if (!baseUrl) {
    return c.json({ error: 'File server not configured' }, 503)
  }

  const requestUrl = new URL(c.req.url)
  const upstream = await fetch(`${baseUrl}${requestUrl.pathname}${requestUrl.search}`, {
    method: c.req.method,
    headers: buildProxyRequestHeaders(c.req.raw.headers),
    redirect: 'manual',
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  })
})
