import fs from 'node:fs'
import path from 'node:path'
import { chatStub } from '#/server/features/chat-stub/chat-stub'
import { chat } from '#/server/features/chat/chat'
import { convertCompletion, convertStreamChunks } from '#/server/features/chat/converter'
import type { CompletionChunk, ResponsesStreamChunk, StreamChunk } from '#/server/features/chat/transport'
import { logger } from '#/server/lib/logger'
import { ApiChatMessageSchema, type ApiMode } from '#/types'
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
  }
})

const formatValidationPath = (path: unknown): string => {
  if (!Array.isArray(path) || path.length === 0) return 'request body'

  const keys = path
    .map((segment) => {
      if (typeof segment === 'string' || typeof segment === 'number') return String(segment)
      if (segment && typeof segment === 'object' && 'key' in segment) return String(segment.key)
      return null
    })
    .filter((segment): segment is string => Boolean(segment))

  return keys.join('.') || 'request body'
}

const chatBodyValidator = sValidator('json', ChatApiRequestSchema, (result, c) => {
  if (result.success) return

  const issue = result.error[0]
  const fieldName = formatValidationPath(issue?.path)

  return c.json(
    {
      error: `Invalid request body '${fieldName}'`,
      code: 'VALIDATION_ERROR' as const,
    },
    400
  )
})

function normalizeApiMode(apiMode: ApiMode | undefined): ApiMode {
  return apiMode ?? 'chat_completions'
}

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
  .post('/api/chat', chatHeaderValidator, chatBodyValidator, async (c) => {
    const header = c.req.valid('header')
    const req = c.req.valid('json')
    const apiMode = normalizeApiMode(req.apiMode)
    const requestLogger = c.var.logger ?? logger

    try {
      const completion = await chat.completions(
        {
          apiKey: header['api-key'],
          baseURL: header['base-url'],
        },
        {
          apiMode,
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          reasoningEffort: req.reasoningEffort,
          stream: false,
        }
      )

      const response = convertCompletion(apiMode, completion as CompletionChunk)
      requestLogger.debug({ response }, 'Chat completion converted')
      return c.json(response)
    } catch (err) {
      requestLogger.error({ err }, 'Upstream chat completion failed')
      return c.json(
        { error: err instanceof Error ? err.message : 'Upstream error', code: 'UPSTREAM_ERROR' as const },
        502
      )
    }
  })
  // SSE ストリーム専用
  .post('/api/chat/stream', chatHeaderValidator, chatBodyValidator, async (c) => {
    const header = c.req.valid('header')
    const req = c.req.valid('json')
    const apiMode = normalizeApiMode(req.apiMode)
    const requestLogger = c.var.logger ?? logger

    let completion
    try {
      completion = await chat.completions(
        {
          apiKey: header['api-key'],
          baseURL: header['base-url'],
        },
        {
          apiMode,
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
      requestLogger.error({ err }, 'Upstream stream chat failed')
      return c.json(
        { error: err instanceof Error ? err.message : 'Upstream error', code: 'UPSTREAM_ERROR' as const },
        502
      )
    }

    const streamCompletion = completion as StreamChunk | ResponsesStreamChunk

    return streamSSE(c, async (stream) => {
      let aborted = false

      stream.onAbort(() => {
        aborted = true
        streamCompletion.controller.abort()
      })

      for await (const event of convertStreamChunks(apiMode, streamCompletion)) {
        requestLogger.debug({ event }, 'Stream event emitted')
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
    const requestLogger = c.var.logger ?? logger

    requestLogger.debug({ req }, 'Stub chat request received')
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
    requestLogger.debug({ completion }, 'Stub chat completion received')

    return c.json(completion)
  })

export { chatRoutes }
