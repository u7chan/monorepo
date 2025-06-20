import fs from 'node:fs'
import path from 'node:path'

import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { validator } from 'hono/validator'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'

import { AuthenticationError, auth } from '#/server/features/auth/auth'
import type {
  CompletionChunk,
  StreamChunk,
  StreamCompletionChunk,
} from '#/server/features/chat/chat'
import { chat, MessageSchema } from '#/server/features/chat/chat'
import {
  type ChatMessage,
  chatConversationRepository,
  type MutableChatMessage,
} from '#/server/features/chat-conversations/chat-conversations'
import { chatStub } from '#/server/features/chat-stub/chat-stub'
import { cookie } from '#/server/features/cookie/cookie'

type Env = Partial<{
  NODE_ENV: string
  SERVER_PORT: string
  DATABASE_URL: string
  COOKIE_SECRET: string
  COOKIE_NAME: string
  COOKIE_EXPIRES: string
}>

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
      const {
        DATABASE_URL = '',
        COOKIE_SECRET = '',
        COOKIE_NAME = '',
        COOKIE_EXPIRES = '1d',
      } = env<Env>(c)
      await auth.login(DATABASE_URL, email, password)
      await setSignedCookie(
        c,
        COOKIE_NAME,
        email,
        COOKIE_SECRET,
        cookie.createOptions(COOKIE_EXPIRES),
      )
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
      const conversationId = value['conversation-id']
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
        'conversation-id': conversationId,
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
      const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)

      const header = c.req.valid('header')
      const req = c.req.valid('json')

      const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
      if (!email) {
        deleteCookie(c, COOKIE_NAME)
      }

      const conversationId = header['conversation-id']
      const lastContent = req.messages.at(-1)?.content
      const userMessage: ChatMessage = {
        content: typeof lastContent === 'string' ? lastContent : '',
        metadata: {
          model: req.model,
          stream: req.stream,
          temperature: req.temperature,
          max_tokens: req.max_tokens,
        },
      }

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
            const chunks: StreamCompletionChunk[] = []
            stream.onAbort(() => {
              aborted = true
              completionStream.controller.abort()
            })
            const completionStream = completion as StreamChunk
            for await (const chunk of completionStream) {
              chunks.push(chunk)
              await stream.writeSSE({ data: JSON.stringify(chunk) })
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            if (!aborted) {
              await stream.writeSSE({ data: '[DONE]' })
            }
            const assistantMessage = chunks.reduce(
              (p, c) => {
                if (c.choices[0].delta?.content) {
                  p.content += c.choices[0].delta.content || ''
                }
                if (c.choices[0].delta?.reasoning_content) {
                  p.reasoning_content += c.choices[0].delta.reasoning_content || ''
                }
                if (c.model) {
                  p.metadata.model = c.model
                }
                if (c.choices[0].finish_reason) {
                  p.metadata.finish_reason = c.choices[0].finish_reason || ''
                }
                if (c.usage?.completion_tokens) {
                  p.metadata.completion_tokens = c.usage.completion_tokens
                }
                if (c.usage?.prompt_tokens) {
                  p.metadata.prompt_tokens = c.usage.prompt_tokens
                }
                if (c.usage?.total_tokens) {
                  p.metadata.total_tokens = c.usage.total_tokens
                }
                if (c.usage?.completion_tokens_details?.reasoning_tokens) {
                  p.metadata.reasoning_tokens = c.usage.completion_tokens_details.reasoning_tokens
                }
                return p
              },
              {
                content: '',
                reasoning_content: '',
                metadata: {
                  model: '',
                  finish_reason: '',
                },
              } as MutableChatMessage,
            )
            await chatConversationRepository.save(DATABASE_URL, email || '', conversationId, {
              user: userMessage,
              assistant: assistantMessage,
            })
          })
        : await (async () => {
            const result = completion as CompletionChunk
            const { model, usage } = result
            const {
              finish_reason,
              message: { content, reasoning_content },
            } = result.choices[0]
            const assistantMessage: ChatMessage = {
              content: content || '',
              reasoning_content: reasoning_content || '',
              metadata: {
                model,
                finish_reason,
                completion_tokens: usage?.completion_tokens,
                prompt_tokens: usage?.prompt_tokens,
                total_tokens: usage?.total_tokens,
                reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens,
              },
            }
            await chatConversationRepository.save(DATABASE_URL, email || '', conversationId, {
              user: userMessage,
              assistant: assistantMessage,
            })
            return c.json(result)
          })()
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
      await new Promise((resolve) => setTimeout(resolve, 3000)) // delay

      const reasoningContent = fs.readFileSync(
        path.join(process.cwd(), 'src/server/data/chat-stub-reasoning-content.md'),
        'utf8',
      )
      const content = fs.readFileSync(
        path.join(process.cwd(), 'src/server/data/chat-stub-content.md'),
        'utf8',
      )

      console.log('<--[Request]')
      return req.stream
        ? streamSSE(c, async (stream) => {
            let aborted = false
            stream.onAbort(() => {
              aborted = true
            })
            await chatStub.streamCompletions({
              model: req.model,
              reasoningContent,
              content,
              maxTokens: req.max_tokens,
              includeUsage: req.stream_options?.include_usage,
              onChunk: async (chunk) => {
                await stream.writeSSE({
                  data: JSON.stringify(chunk),
                })
                return aborted
              },
            })
            if (!aborted) {
              await stream.writeSSE({ data: '[DONE]' })
            }
          })
        : c.json(await chatStub.completions(req.model, content))
    },
  )
  .get('*', async (c) => {
    const { NODE_ENV, DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)
    const prod = NODE_ENV === 'production'
    const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
    if (!email) {
      deleteCookie(c, COOKIE_NAME)
    } else {
      // 検証用
      if (c.req.path === '/chat') {
        const conversations = await chatConversationRepository.read(DATABASE_URL, email)
        console.log('#conversations', conversations)
      }
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
