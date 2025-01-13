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
        llm: z.enum(['openai', 'deepseek'], {
          message: 'llmは「openai」または「deepseek」を指定してください',
        }),
        message: z.string().min(1, { message: 'messageは1文字以上でなければなりません' }),
      }),
    ),
    async (c) => {
      const { llm, message } = c.req.valid('form')
      const getLLMConfigs = (
        llm: 'openai' | 'deepseek',
      ): { url: string; key: string; model: string } => {
        const { OPENAI_API_KEY, DEEPSEEK_API_KEY } = env<{
          OPENAI_API_KEY: string
          DEEPSEEK_API_KEY: string
        }>(c)
        const openai = llm === 'openai'
        return {
          url: openai
            ? 'https://api.openai.com/v1/chat/completions'
            : 'https://api.deepseek.com/chat/completions',
          key: openai ? OPENAI_API_KEY : DEEPSEEK_API_KEY,
          model: openai ? 'gpt-4o-mini' : 'deepseek-chat',
        }
      }

      const { url, key, model } = getLLMConfigs(llm)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
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
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      return streamText(c, async (stream) => {
        while (true) {
          const { done, value } = (await reader?.read()) || {}
          if (done) {
            break
          }
          buffer += decoder.decode(value, { stream: true })

          let boundary = buffer.indexOf('\n')
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary).trim()
            buffer = buffer.slice(boundary + 1)
            boundary = buffer.indexOf('\n')

            if (chunk.startsWith('data:')) {
              const jsonStr = chunk.slice(5).trim() // 'data:'部分を除去
              if (jsonStr !== '[DONE]') {
                try {
                  const parsedData = JSON.parse(jsonStr)
                  if (parsedData.choices?.[0].delta.content) {
                    const text = parsedData.choices[0].delta.content
                    await stream.write(text)
                  }
                } catch (error) {
                  console.error('Failed to parse JSON:', error)
                }
              }
            }
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
