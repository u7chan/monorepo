import fs from 'node:fs'
import path from 'node:path'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { streamSSE } from 'hono/streaming'
import { validator } from 'hono/validator'
import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'

type Env = {
  NODE_ENV?: string
  SERVER_PORT?: string
}

type HonoEnv = {
  Bindings: Env
}

const MessageSchema = z.union([
  z.object({
    role: z.enum(['system']),
    content: z.string().min(1),
  }),
  z.object({
    role: z.enum(['assistant']),
    content: z.string().min(1),
  }),
  z.object({
    role: z.enum(['user']),
    content: z.union([
      z.string().min(1),
      z
        .union([
          z.object({
            type: z.enum(['text']),
            text: z.string().min(1),
          }),
          z.object({
            type: z.enum(['image_url']),
            image_url: z.object({
              url: z.string().min(1),
              detail: z.enum(['auto', 'low', 'high']).optional(),
            }),
          }),
        ])
        .array(),
    ]),
  }),
])

const app = new Hono<HonoEnv>()
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
      const fakeMode = apiKey === 'fakemode' && apiKey === 'fakemode'
      const mcpServerURLs = value['mcp-server-urls']
      if (!apiKey) {
        return c.json({ message: `Validation Error: Missing required header 'api-key'` }, 400)
      }
      if (!baseURL) {
        return c.json({ message: `Validation Error: Missing required header 'base-url'` }, 400)
      }
      if (!fakeMode && !z.string().url().safeParse(baseURL).success) {
        return c.json({ message: `Validation Error: Invalid url 'base-url'` }, 400)
      }
      const { SERVER_PORT: port } = env<Env>(c)
      const fakeBaseURL = `http://localhost:${port || 3000}/api`
      return {
        'api-key': apiKey,
        'base-url': fakeMode ? fakeBaseURL : baseURL,
        'mcp-server-urls': mcpServerURLs,
      }
    }),
    sValidator(
      'json',
      z.object({
        messages: MessageSchema.array(),
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
          fetch: async (url, options = {}) => {
            // カスタムヘッダーを追加
            const customHeaders = {
              'mcp-server-urls': header['mcp-server-urls'],
            }
            // options.headers の型をチェックして、適切にマージ
            let existingHeaders: Record<string, string> = {}

            if (options.headers instanceof Headers) {
              // Headersオブジェクトの場合は安全にRecord<string, string>に変換
              existingHeaders = {}
              options.headers.forEach((value, key) => {
                if (typeof key === 'string' && typeof value === 'string') {
                  existingHeaders[key] = value
                }
              })
            } else if (typeof options.headers === 'object' && options.headers !== null) {
              // plain objectの場合は安全にフィルタリングしてコピー
              existingHeaders = Object.fromEntries(
                Object.entries(options.headers).filter(
                  ([key, value]) => typeof key === 'string' && typeof value === 'string',
                ),
              )
            }

            // マージして新しいヘッダーをセット
            options.headers = {
              ...existingHeaders,
              ...customHeaders,
            }
            return fetch(url, options)
          },
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
                await new Promise((resolve) => setTimeout(resolve, 10))
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
        messages: MessageSchema.array(),
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

      console.log('[Request]-->')
      console.dir(req, { depth: null })
      console.log('<--[Request]')

      const splitByLength = (text: string, length: number): string[] => {
        const result = []
        for (let i = 0; i < text.length; i += length) {
          result.push(text.slice(i, i + length))
        }
        return result
      }

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
            const contentList = [
              `これからストリームで返すデータは ${repeatCount} 回繰り返します 🚀`,
              '\n\n',
              ...splitByLength(content.repeat(repeatCount), chunkSize),
              'ストリームの終端です 🚀',
            ]
            const reasoningContent =
              'こちらのコンテンツは、推論を行うための基盤となる情報や知識を提供し、さまざまな状況や問題に対して論理的に考える力を養うことを目的としています。\nこれにより、より深い理解と正確な結論を導き出すための思考の枠組みを構築できるようになることを意図しています。\nそしてこれはダミーの推論です。'
            const chunkList = [
              ...splitByLength(reasoningContent, chunkSize).map((text) => ({
                content: undefined,
                reasoning_content: text,
              })),
              ...contentList.map((text) => ({
                content: text,
                reasoning_content: undefined,
              })),
            ]
            for (const chunk of chunkList) {
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
                        content: chunk.content,
                        reasoning_content: chunk.reasoning_content,
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
    const { NODE_ENV } = env<Env>(c)
    const prod = NODE_ENV === 'production'
    return c.html(
      renderToString(
        <html lang='ja'>
          <head>
            <meta charSet='utf-8' />
            <meta content='width=device-width, initial-scale=1' name='viewport' />
            <title>Portfolio</title>
            <link rel='icon' href={prod ? '/static/favicon.ico' : 'favicon.ico'} />
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
