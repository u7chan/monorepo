import fs from 'node:fs'
import path from 'node:path'
import { chatStub } from '#/server/features/chat-stub/chat-stub'
import { chat } from '#/server/features/chat/chat'
import { convertCompletion, convertStreamChunks } from '#/server/features/chat/converter'
import type { CompletionChunk, StreamChunk } from '#/server/features/chat/transport'
import { logger } from '#/server/lib/logger'
import { ApiChatMessageSchema } from '#/types'
import { ChatApiRequestSchema } from '#/types/chat-api'
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

// /api/chat/completions stub endpoint 用スキーマ (OpenAI 互換)
const StubChatRequestSchema = z.object({
  messages: ApiChatMessageSchema.array(),
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

const chatHeaderValidator = validator('header', (value, c) => {
  const parsed = ChatHeaderSchema.safeParse({
    'api-key': value['api-key'],
    'base-url': value['base-url'],
    'mcp-server-urls': value['mcp-server-urls'],
  })

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const headerName = String(issue?.path[0] ?? 'unknown')

    return c.json({ error: `Missing required header '${headerName}'`, code: 'VALIDATION_ERROR' as const }, 400)
  }

  const headers = parsed.data
  const fakeMode = headers['api-key'] === 'fakemode'

  if (!fakeMode && !z.string().url().safeParse(headers['base-url']).success) {
    return c.json({ error: `Invalid url 'base-url'`, code: 'VALIDATION_ERROR' as const }, 400)
  }

  const { SERVER_PORT: port } = getServerEnv(c)
  const fakeBaseURL = `http://localhost:${port || 3000}/api`

  return {
    'api-key': headers['api-key'],
    'base-url': fakeMode ? fakeBaseURL : headers['base-url'],
    'mcp-server-urls': headers['mcp-server-urls'],
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

const chatRoutes = new Hono<HonoEnv>()
  // 非ストリーム専用
  .post('/api/chat', chatHeaderValidator, sValidator('json', ChatApiRequestSchema), async (c) => {
    const header = c.req.valid('header')
    const req = c.req.valid('json')

    try {
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
          maxTokens: req.maxTokens,
          reasoningEffort: req.reasoningEffort,
          stream: false,
        }
      )

      const response = convertCompletion(completion as CompletionChunk)
      logger.debug({ response }, 'Chat completion converted')
      return c.json(response)
    } catch (err) {
      logger.error({ err }, 'Upstream chat completion failed')
      return c.json(
        { error: err instanceof Error ? err.message : 'Upstream error', code: 'UPSTREAM_ERROR' as const },
        502
      )
    }
  })
  // SSE ストリーム専用
  .post('/api/chat/stream', chatHeaderValidator, sValidator('json', ChatApiRequestSchema), async (c) => {
    const header = c.req.valid('header')
    const req = c.req.valid('json')

    let completion
    try {
      completion = await chat.completions(
        {
          apiKey: header['api-key'],
          baseURL: header['base-url'],
          mcpServerURLs: header['mcp-server-urls'] ?? '',
        },
        {
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          reasoningEffort: req.reasoningEffort,
          stream: true,
          includeUsage: true,
        }
      )
    } catch (err) {
      logger.error({ err }, 'Upstream stream chat failed')
      return c.json(
        { error: err instanceof Error ? err.message : 'Upstream error', code: 'UPSTREAM_ERROR' as const },
        502
      )
    }

    const streamCompletion = completion as StreamChunk

    return streamSSE(c, async (stream) => {
      let aborted = false

      stream.onAbort(() => {
        aborted = true
        streamCompletion.controller.abort()
      })

      for await (const event of convertStreamChunks(streamCompletion)) {
        logger.debug({ event }, 'Stream event emitted')
        await stream.writeSSE({ data: JSON.stringify(event) })
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      if (!aborted) {
        await stream.writeSSE({ data: '[DONE]' })
      }
    })
  })
  // Stub endpoint (OpenAI 互換、変更なし)
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
    logger.debug({ completion }, 'Stub chat completion received')

    return c.json(completion)
  })

export { chatRoutes }
