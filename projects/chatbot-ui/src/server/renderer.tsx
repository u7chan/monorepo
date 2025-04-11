import { reactRenderer } from '@hono/react-renderer'
import type { Context } from 'hono'
import { env } from 'hono/adapter'
import type { MiddlewareHandler } from 'hono/types'
import type { ReactNode } from 'react'
import type { Env } from '#/server/env'

type Props = {
  children: ReactNode
  c: Context<Env>
}

export const renderer: MiddlewareHandler = reactRenderer(({ children, c }: Props) => {
  const devmode = env(c).DEV_MODE === 'true'
  return (
    <html lang='ja'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1.0' />
        <link rel='stylesheet' href={devmode ? '/src/client/main.css' : '<TODO>'} />
        <script type='module' src={devmode ? '/src/client/main.tsx' : '/static/client.js'} />
      </head>
      <body>{children}</body>
    </html>
  )
})
