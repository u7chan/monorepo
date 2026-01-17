import fs from 'node:fs'
import path from 'node:path'
import { AuthenticationError, auth } from '#/server/features/auth/auth'
import { chatConversationRepository } from '#/server/features/chat-conversations/chat-conversation-repository'
import { chatStub } from '#/server/features/chat-stub/chat-stub'
import type { StreamChunk, StreamCompletionChunk } from '#/server/features/chat/chat'
import { chat, MessageSchema } from '#/server/features/chat/chat'
import { cookie } from '#/server/features/cookie/cookie'
import { ConversationSchema } from '#/types'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { validator } from 'hono/validator'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'

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
      })
    ),
    async (c) => {
      const { email, password } = c.req.valid('json')
      const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '', COOKIE_EXPIRES = '1d' } = env<Env>(c)
      await auth.login(DATABASE_URL, email, password)
      await setSignedCookie(c, COOKIE_NAME, email, COOKIE_SECRET, cookie.createOptions(COOKIE_EXPIRES))
      return c.json({})
    }
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
      })
    ),
    async (c) => {
      const { COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)

      const header = c.req.valid('header')
      const req = c.req.valid('json')

      const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
      if (!email) {
        deleteCookie(c, COOKIE_NAME)
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
        }
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
          })
        : c.json(completion)
    }
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
      })
    ),
    async (c) => {
      const req = c.req.valid('json')

      console.log('[Request]-->')
      console.dir(req, { depth: null })
      await new Promise((resolve) => setTimeout(resolve, 3000)) // delay

      const reasoningContent = fs.readFileSync(
        path.join(process.cwd(), 'src/server/data/chat-stub-reasoning-content.md'),
        'utf8'
      )
      const content = fs.readFileSync(path.join(process.cwd(), 'src/server/data/chat-stub-content.md'), 'utf8')

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
    }
  )
  .get('/api/conversations', async (c) => {
    const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)
    const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
    if (!email) {
      deleteCookie(c, COOKIE_NAME)
      return c.json({ data: [] })
    }
    const conversations = await chatConversationRepository.read(DATABASE_URL, email)
    if (!conversations) {
      return c.json({ data: [] })
    }
    return c.json({ data: conversations })
  })
  .post('/api/conversations', sValidator('json', ConversationSchema), async (c) => {
    const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)
    const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
    if (!email) {
      deleteCookie(c, COOKIE_NAME)
      return c.json({ error: 'Authentication error' }, 401)
    }
    const req = c.req.valid('json')
    await chatConversationRepository.upsert(DATABASE_URL, email, req)
    return c.json({ conversationId: req.id })
  })
  .delete(
    '/api/conversations',
    sValidator(
      'query',
      z.object({
        ids: z.union([z.string(), z.array(z.string())]).transform((value) => (Array.isArray(value) ? value : [value])),
      })
    ),
    async (c) => {
      const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)
      const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
      if (!email) {
        deleteCookie(c, COOKIE_NAME)
        return c.json({ error: 'Authentication error' }, 401)
      }
      const { ids } = c.req.valid('query')
      const result = await chatConversationRepository.delete(DATABASE_URL, email, ids)
      return c.json(result)
    }
  )
  .delete(
    '/api/conversations/messages',
    sValidator(
      'query',
      z.object({
        ids: z.union([z.string(), z.array(z.string())]).transform((value) => (Array.isArray(value) ? value : [value])),
      })
    ),
    async (c) => {
      const { DATABASE_URL = '', COOKIE_SECRET = '', COOKIE_NAME = '' } = env<Env>(c)
      const email = await getSignedCookie(c, COOKIE_SECRET, COOKIE_NAME)
      if (!email) {
        deleteCookie(c, COOKIE_NAME)
        return c.json({ error: 'Authentication error' }, 401)
      }
      const { ids } = c.req.valid('query')
      const result = await chatConversationRepository.deleteMessages(DATABASE_URL, email, ids)
      return c.json(result)
    }
  )
  .get(
    '/api/fetch-models',
    validator('header', (value, c) => {
      const apiKey = value['api-key']
      const baseURL = value['base-url']
      if (!apiKey) {
        return c.json({ message: `Validation Error: Missing required header 'api-key'` }, 400)
      }
      if (!baseURL) {
        return c.json({ message: `Validation Error: Missing required header 'base-url'` }, 400)
      }
      return {
        'api-key': apiKey,
        'base-url': baseURL,
      }
    }),
    async (c) => {
      const { 'api-key': apiKey, 'base-url': baseURL } = c.req.valid('header')
      try {
        const response = await fetch(`${baseURL}/models`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        })
        if (response.ok) {
          const data = await response.json()
          const models: string[] = data.data?.map((item: { id: string }) => item.id) || []
          return c.json(models.toSorted())
        }
      } catch (error) {
        console.error('Failed to fetch models:', error)
      }
      return c.json([])
    }
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
        </html>
      )
    )
  })

export type AppType = typeof app
export default app
