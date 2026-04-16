import fs from 'node:fs'
import path from 'node:path'
import { chatStub } from '#/server/features/chat-stub/chat-stub'
import type { StreamChunk } from '#/server/features/chat/chat'
import { chat } from '#/server/features/chat/chat'
import { logger } from '#/server/lib/logger'
import { ApiChatRequestSchema } from '#/types'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { validator } from 'hono/validator'
import { z } from 'zod'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const ChatHeaderSchema = z.object({
  'api-key': z.string().min(1),
  'base-url': z.string().min(1),
  'mcp-server-urls': z.string().optional(),
})

// /api/chat stub endpoint 用スキーマ（reasoning_effort なし）
const StubChatRequestSchema = ApiChatRequestSchema.omit({ reasoning_effort: true })

const chatHeaderValidator = validator('header', (value, c) => {
  const parsed = ChatHeaderSchema.safeParse({
    'api-key': value['api-key'],
    'base-url': value['base-url'],
    'mcp-server-urls': value['mcp-server-urls'],
  })

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const headerName = String(issue?.path[0] ?? 'unknown')

    return c.json({ message: `Validation Error: Missing required header '${headerName}'` }, 400)
  }

  const headers = parsed.data
  const fakeMode = headers['api-key'] === 'fakemode'

  if (!fakeMode && !z.string().url().safeParse(headers['base-url']).success) {
    return c.json({ message: `Validation Error: Invalid url 'base-url'` }, 400)
  }

  const { SERVER_PORT: port } = getServerEnv(c)
  const fakeBaseURL = `http://localhost:${port || 3000}/api`

  return {
    'api-key': headers['api-key'],
    'base-url': fakeMode ? fakeBaseURL : headers['base-url'],
    'mcp-server-urls': headers['mcp-server-urls'],
  }
})

const streamChatCompletion = (c: Parameters<typeof streamSSE>[0], completion: StreamChunk) =>
  streamSSE(c, async (stream) => {
    let aborted = false

    stream.onAbort(() => {
      aborted = true
      completion.controller.abort()
    })

    for await (const chunk of completion) {
      logger.debug({ chunk }, 'Stream chunk received')
      await stream.writeSSE({ data: JSON.stringify(chunk) })
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    if (!aborted) {
      await stream.writeSSE({ data: '[DONE]' })
    }
  })

const streamStubCompletion = (
  c: Parameters<typeof streamSSE>[0],
  req: z.infer<typeof StubChatRequestSchema>,
  reasoningContent: string,
  content: string
) =>
  streamSSE(c, async (stream) => {
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

const debugLogCompletion = <T>(completion: T, message: string): T => {
  logger.debug({ completion }, message)
  return completion
}

const chatRoutes = new Hono<HonoEnv>()
  .post('/api/chat', chatHeaderValidator, sValidator('json', ApiChatRequestSchema), async (c) => {
    const header = c.req.valid('header')
    const req = c.req.valid('json')

    const completion = await chat.completions(
      {
        apiKey: header['api-key'],
        baseURL: header['base-url'],
        mcpServerURLs: header['mcp-server-urls'] ?? '',
      },
      {
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.max_tokens,
        reasoningEffort: req.reasoning_effort,
        stream: req.stream,
        includeUsage: req.stream_options?.include_usage,
      }
    )

    return req.stream
      ? streamChatCompletion(c, completion as StreamChunk)
      : c.json(debugLogCompletion(completion, 'Chat completion received'))
  })
  .post('/api/chat/completions', sValidator('json', StubChatRequestSchema), async (c) => {
    const req = c.req.valid('json')

    logger.debug({ req }, 'Stub chat request received')
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const reasoningContent = fs.readFileSync(
      path.join(process.cwd(), 'src/server/data/chat-stub-reasoning-content.md'),
      'utf8'
    )
    const content = fs.readFileSync(path.join(process.cwd(), 'src/server/data/chat-stub-content.md'), 'utf8')

    if (req.stream) {
      return streamStubCompletion(c, req, reasoningContent, content)
    }

    const completion = await chatStub.completions(req.model, content)

    return c.json(debugLogCompletion(completion, 'Stub chat completion received'))
  })

export { chatRoutes }
