import { Hono } from 'hono'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'

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
  .get('*', (c) => {
    return c.html(
      renderToString(
        <html lang='ja'>
          <head>
            <meta charSet='utf-8' />
            <meta content='width=device-width, initial-scale=1' name='viewport' />
            <link rel='stylesheet' href='/src/main.css' />
            <script type='module' src='/src/client.tsx' />
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
