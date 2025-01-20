import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { zValidator } from '@hono/zod-validator'
import { streamText } from 'hono/streaming'
import { renderToString } from 'react-dom/server'
import { z, type ZodError } from 'zod'

import { getLLMProvider } from './llm/getLLMProvider'

const app = new Hono()
  .post(
    '/api/profile',
    zValidator(
      'form',
      z.object({
        name: z.string().min(2, { message: 'nameは2文字以上でなければなりません' }),
        email: z.string().email({ message: 'emailは正しい形式ではありません' }),
      }),
      (values, c) => {
        const result = values as { error?: ZodError; success: boolean }
        if (result.success) {
          return
        }
        return c.json({ error: result?.error?.issues?.map((x) => x.message)?.join(',') || '' }, 400)
      },
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
      'json',
      z.object({
        llm: z.enum(['openai', 'deepseek'], {
          message: "llmは'openai','deepseek'のいずれかを指定してください",
        }),
        temperature: z.number().min(0).max(1).nullish(),
        maxTokens: z
          .number()
          .min(1, { message: 'maxTokensは1以上でなければなりません' })
          .max(4096, { message: 'maxTokensは4096以下でなければなりません' })
          .nullish(),
        userInput: z.string().min(1, { message: 'userInputは1文字以上でなければなりません' }),
      }),
      (values, c) => {
        const result = values as { error?: ZodError; success: boolean }
        if (result.success) {
          return
        }
        return c.json({ error: result?.error?.issues?.map((x) => x.message)?.join(',') || '' }, 400)
      },
    ),
    async (c) => {
      const { llm, temperature, maxTokens, userInput } = c.req.valid('json')
      const envs = env<{
        OPENAI_API_KEY: string
        DEEPSEEK_API_KEY: string
      }>(c)

      const llmProvider = getLLMProvider(llm, envs)
      const reader = await llmProvider.chatStream(userInput, temperature, maxTokens)

      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      return streamText(c, async (stream) => {
        while (true) {
          const { done, value } = (await reader.read()) || {}
          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n')

          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary).trim()
            buffer = buffer.slice(boundary + 1)
            boundary = buffer.indexOf('\n')

            if (!chunk.startsWith('data:')) {
              continue
            }

            const jsonStr = chunk.slice(5).trim() // 'data:'部分を除去
            if (jsonStr !== '[DONE]') {
              try {
                const { choices, usage } = JSON.parse(jsonStr) as {
                  id: string
                  model: string
                  choices: { delta: { content?: string }; finish_reason?: string }[]
                  usage: {
                    prompt_tokens: number
                    completion_tokens: number
                    total_tokens: number
                  } | null
                }
                const text = choices.at(0)?.delta?.content || ''
                const finishReason = choices.at(0)?.finish_reason || ''

                if (finishReason) {
                  console.log(`finish_reason=${finishReason}`)
                }

                if (usage) {
                  console.log(
                    `prompt_tokens=${usage.prompt_tokens}, completion_tokens=${usage.completion_tokens}`,
                  )
                }

                if (text) {
                  await stream.write(text)
                }
              } catch (error) {
                console.error('Failed to parse JSON:', error)
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
  .onError((err, c) => {
    return c.json({ error: err.message }, 500)
  })

export type AppType = typeof app

export default app
