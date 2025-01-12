import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { zValidator } from '@hono/zod-validator'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'
import { streamText } from 'hono/streaming'

const app = new Hono()
  .post(
    '/api/profile',
    zValidator(
      'form',
      z.object({
        name: z.string().min(2, { message: 'nameは2文字以上でなければなりません' }),
        email: z.string().email({ message: 'emailは正しい形式ではありません' }),
      }),
    ),
    (c) => {
      const { name, email } = c.req.valid('form')
      // TODO: save
      console.log('#submit', { name, email })
      return c.json({ name, email })
    },
  )
  .post(
    '/api/chat',
    zValidator(
      'form',
      z.object({
        message: z.string().min(1, { message: 'messageは1文字以上でなければなりません' }),
      }),
    ),
    (c) => {
      return streamText(c, async (stream) => {
        const inputString = 'これはテスト用の長い文字列です。'
        for (const char of inputString) {
          await stream.writeln(char)
          await stream.sleep(100)
        }
      })
    },
  )
  .get('*', (c) => {
    const { NODE_ENV } = env<{ NODE_ENV: string }>(c)
    const prod = NODE_ENV === 'production'
    return c.html(
      renderToString(
        <html lang='ja'>
          <head>
            <meta charSet='utf-8' />
            <meta content='width=device-width, initial-scale=1' name='viewport' />
            <link rel='stylesheet' href={prod ? '/static/main.css' : '/src/main.css'} />
            <script type='module' src={prod ? '/static/client.js' : '/src/client.tsx'} />
          </head>
          <body>
            <div id='root' />
          </body>
        </html>,
      ),
    )
  })

export type AppType = typeof app

export default app
