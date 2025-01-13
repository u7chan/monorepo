import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { zValidator } from '@hono/zod-validator'
import { streamText } from 'hono/streaming'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'

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
    async (c) => {
      const { message } = c.req.valid('form')
      const { OPENAI_API_KEY } = env<{ OPENAI_API_KEY: string }>(c)
      const url = 'https://api.openai.com/v1/chat/completions'
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: message }],
          stream: true,
        }),
      })
      if (!res.ok) {
        const json = await res.json()
        c.status(500)
        return c.text(json.error.message)
      }
      const reader = res.body?.getReader()
      return streamText(c, async (stream) => {
        while (true) {
          const { done, value } = (await reader?.read()) || {}
          if (done) break
          const chunk = new TextDecoder().decode(value)
          const chunks = `[${chunk
            .replaceAll('data: ', '')
            .replaceAll('[DONE]\n\n', '')
            .replaceAll('}\n', '}')
            .replaceAll('}\n', '}')
            .replaceAll('}{', '},{')}]`
          const content = (
            JSON.parse(chunks) as {
              choices: { delta: { content: string } }[]
            }[]
          )
            .map((x) => x.choices[0].delta.content)
            .filter((x) => x)
            .join('')
          if (content) {
            await stream.write(content)
          }
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
