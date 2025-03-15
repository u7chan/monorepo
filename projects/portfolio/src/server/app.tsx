import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { validator } from 'hono/validator'
import { sValidator } from '@hono/standard-validator'
import { streamSSE } from 'hono/streaming'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'
import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'

type Env = {
  Bindings: {
    NODE_ENV?: string
    OPENAI_API_KEY?: string
    DEEPSEEK_API_KEY?: string
  }
}

const app = new Hono<Env>()
  .post(
    '/api/profile',
    sValidator(
      'form',
      z.object({
        name: z.string().min(2, { message: 'nameは2文字以上でなければなりません' }),
        email: z.string().email({ message: 'emailは正しい形式ではありません' }),
      }),
      (values, c) => {
        const { success, error = [] } = values as {
          success: boolean
          error?: { message: string }[]
        }
        if (success) {
          return
        }
        return c.json({ error: error.map((x) => x.message).join(',') || '' }, 400)
      },
    ),
    (c) => {
      const { name, email } = c.req.valid('form') // form-data; で受け取る場合
      console.log('req', { name, email })
      return c.json({ name, email, updated_at: new Date().toISOString() })
    },
  )
  .post(
    '/api/chat',
    validator('header', (value, c) => {
      const apiKey = value['api-key']
      const baseURL = value['base-url']
      if (!apiKey) {
        return c.json({ message: `Validation Error: Missing required header 'api-key'` }, 400)
      }
      if (!baseURL) {
        return c.json({ message: `Validation Error: Missing required header 'base-url'` }, 400)
      }
      if (!z.string().url().safeParse(baseURL).success) {
        return c.json({ message: `Validation Error: Invalid url 'base-url'` }, 400)
      }
      return { 'api-key': apiKey, 'base-url': baseURL }
    }),
    sValidator(
      'json',
      z.object({
        messages: z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
          })
          .array(),
        model: z.string().min(1),
        stream: z.boolean().default(false),
        temperature: z.number().min(0).max(1).optional(),
        max_tokens: z.number().min(1).optional(),
        stream_options: z
          .object({
            include_usage: z.boolean().optional(),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const header = c.req.valid('header')
      const req = c.req.valid('json')
      try {
        const openai = new OpenAI({
          apiKey: header['api-key'],
          baseURL: header['base-url'],
        })
        const completion = await openai.chat.completions.create({
          messages: req.messages,
          model: req.model,
          stream: req.stream,
          temperature: req.temperature,
          max_tokens: req.max_tokens,
          stream_options: req.stream_options,
        })
        return req.stream
          ? streamSSE(c, async (stream) => {
              let aborted = false
              stream.onAbort(() => {
                aborted = true
                completionStream.controller.abort()
              })
              const completionStream = completion as Stream<OpenAI.ChatCompletionChunk>
              for await (const chunk of completionStream) {
                await stream.writeSSE({ data: JSON.stringify(chunk) })
              }
              if (!aborted) {
                await stream.writeSSE({ data: '[DONE]' })
              }
            })
          : c.json(completion as OpenAI.ChatCompletion)
      } catch (e) {
        console.error(e)
        return c.json({ message: e instanceof Error && e.message }, 500)
      }
    },
  )
  .post(
    '/api/chat/completions',
    sValidator(
      'json',
      z.object({
        messages: z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
          })
          .array(),
        model: z.string().min(1),
        stream: z.boolean().default(false),
        temperature: z.number().min(0).max(1).optional(),
        max_tokens: z.number().min(1).optional(),
        stream_options: z
          .object({
            include_usage: z.boolean().optional(),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const req = c.req.valid('json')
      console.log('req', req)
      const filePath = path.join(process.cwd(), 'src/server/data/test.md')
      const content = fs.readFileSync(filePath, 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 3000)) // delay
      return req.stream
        ? streamSSE(c, async (stream) => {
            let aborted = false
            stream.onAbort(() => {
              aborted = true
            })
            const chunkResponse: OpenAI.ChatCompletionChunk = {
              id: 'chatcmpl-1234567890abcdef',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: req.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: '',
                  },
                  finish_reason: null,
                },
              ],
              usage: null,
            }
            const chunkSize = 5
            const repeatCount = 3
            const generateChunkedRepeatedStrings = (
              input: string,
              chunkSize: number,
              repeatCount: number,
            ): string[] => {
              const repeatedString = input.repeat(repeatCount)
              const chunks: string[] = []
              for (let i = 0; i < repeatedString.length; i += chunkSize) {
                chunks.push(repeatedString.slice(i, i + chunkSize))
              }
              return chunks
            }
            const chunkList = [
              `これからストリームで返すデータは ${repeatCount} 回繰り返します 🚀`,
              '\n\n',
              ...generateChunkedRepeatedStrings(content, chunkSize, repeatCount),
              'ストリームの終端です 🚀',
            ]
            for (const chunkText of chunkList) {
              if (aborted) {
                break
              }
              await stream.writeSSE({
                data: JSON.stringify({
                  ...chunkResponse,
                  choices: [
                    {
                      ...chunkResponse.choices[0],
                      delta: {
                        role: 'assistant',
                        content: chunkText,
                      },
                    },
                  ],
                }),
              })
              await stream.sleep(35) // delay
            }
            if (aborted) {
              return
            }
            if (req.stream_options?.include_usage) {
              await stream.writeSSE({
                data: JSON.stringify({
                  ...chunkResponse,
                  choices: [
                    {
                      ...chunkResponse.choices[0],
                      delta: null,
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 20,
                    total_tokens: 30,
                  },
                }),
              })
            }
            await stream.writeSSE({ data: '[DONE]' })
          })
        : c.json({
            id: 'chatcmpl-1234567890abcdef',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: req.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content,
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
            },
          } as OpenAI.ChatCompletion)
    },
  )
  .get('*', (c) => {
    const { NODE_ENV } = env<{ NODE_ENV?: string }>(c)
    const prod = NODE_ENV === 'production'
    return c.html(
      renderToString(
        <html lang='ja'>
          <head>
            <meta charSet='utf-8' />
            <meta content='width=device-width, initial-scale=1' name='viewport' />
            <link rel='icon' href='/static/favicon.ico' />
            <link rel='stylesheet' href={prod ? '/static/main.css' : '/src/client/main.css'} />
            <script type='module' src={prod ? '/static/client.js' : '/src/client/main.tsx'} />
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
