import fs from 'node:fs'
import path from 'node:path'
import { AuthenticationError, auth } from '@/server/features/auth/auth'
import { parseDurationToSeconds } from '@/server/features/auth/parseDurationToSeconds'
import { MessageSchema, chat } from '@/server/features/chat/chat'
import type { StreamChunk } from '@/server/features/chat/chat'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { validator } from 'hono/validator'
import type OpenAI from 'openai'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'

type Env = {
  NODE_ENV?: string
  SERVER_PORT?: string
  COOKIE_SECRET?: string
  COOKIE_NAME?: string
  COOKIE_EXPIRES?: string
}

type HonoEnv = {
  Bindings: Env
}

const app = new Hono<HonoEnv>()
  .onError((err, c) => {
    if (err instanceof AuthenticationError) {
      return c.json({ error: err.message }, 401)
    }
    console.error('Unknown Error', err)
    return c.json({ error: err.message }, 500)
  })
  .post(
    'api/signin',
    sValidator(
      'json',
      z.object({
        email: z.string().email(),
        password: z.string().min(1),
      }),
    ),
    async (c) => {
      const { email, password } = c.req.valid('json')
      const { COOKIE_SECRET = '', COOKIE_NAME = '', COOKIE_EXPIRES = '1d' } = env<Env>(c)
      await auth.login(email, password)
      const cookieExpiresSec = parseDurationToSeconds(COOKIE_EXPIRES)
      await setSignedCookie(c, COOKIE_NAME, email, COOKIE_SECRET, {
        path: '/',
        secure: false, // httpのため
        httpOnly: true,
        maxAge: cookieExpiresSec,
        expires: new Date(Date.now() + cookieExpiresSec),
        sameSite: 'Strict',
      })
      return c.json({})
    },
  )
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
      const completion = await chat.completions(
        {
          apiKey: header['api-key'],
          baseURL: header['base-url'],
          mcpServerURLs: header['mcp-server-urls'],
        },
        {
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          maxTokens: req.max_tokens,
          stream: req.stream,
          includeUsage: req.stream_options?.include_usage,
        },
      )
      return req.stream
        ? streamSSE(c, async (stream) => {
            let aborted = false
            stream.onAbort(() => {
              aborted = true
              completionStream.controller.abort()
            })
            const completionStream = completion as StreamChunk
            for await (const chunk of completionStream) {
              await stream.writeSSE({ data: JSON.stringify(chunk) })
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            if (!aborted) {
              await stream.writeSSE({ data: '[DONE]' })
            }
          })
        : c.json(completion as OpenAI.ChatCompletion)
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
            if (req.max_tokens !== undefined) {
              await stream.writeSSE({
                data: JSON.stringify({
                  ...chunkResponse,
                  choices: [
                    {
                      ...chunkResponse.choices[0],
                      delta: {
                        role: 'assistant',
                        content: 'Stop👻',
                        reasoning_content: undefined,
                      },
                      finish_reason: 'length',
                    },
                  ],
                }),
              })
            } else {
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
            }
            if (aborted) {
              return
            }
            await stream.writeSSE({
              data: JSON.stringify({
                ...chunkResponse,
                choices: [
                  {
                    ...chunkResponse.choices[0],
                    delta: null,
                    finish_reason: 'stop',
                  },
                ],
                usage: req.stream_options?.include_usage
                  ? {
                      prompt_tokens: 10,
                      completion_tokens: 20,
                      total_tokens: 30,
                    }
                  : undefined,
              }),
            })
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
  .get('*', async (c) => {
    const { NODE_ENV, COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)
    const prod = NODE_ENV === 'production'
    const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
    if (!email) {
      deleteCookie(c, COOKIE_NAME)
    }
    return c.html(
      renderToString(
        <html lang='ja'>
          <head>
            <meta charSet='utf-8' />
            <meta name='viewport' content='width=device-width, initial-scale=1' />
            <meta name='props' content={`${JSON.stringify({ email })}`} />
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

export type AppType = typeof app
export default app
