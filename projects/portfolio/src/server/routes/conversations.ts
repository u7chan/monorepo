import {
  resolveFileServerConfig,
  resolveFileServerPublicBaseUrl,
} from '#/server/features/chat-conversations/file-server-client'
import { chatConversationRepository } from '#/server/features/chat-conversations/repository'
import { requireAuth } from '#/server/middleware/auth'
import { ApiModeSchema, ConversationSchema, GeneratedCodeFileSchema } from '#/types'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const ConversationIdsQuerySchema = z.object({
  ids: z.union([z.string(), z.array(z.string())]).transform((value) => (Array.isArray(value) ? value : [value])),
})

const AssistantMetadataPatchSchema = z
  .object({
    model: z.string().optional(),
    apiMode: ApiModeSchema.optional(),
    finishReason: z.string().optional(),
    responseTimeMs: z.number().optional(),
    usage: z
      .object({
        completionTokens: z.number().optional(),
        promptTokens: z.number().optional(),
        totalTokens: z.number().optional(),
        reasoningTokens: z.number().optional(),
      })
      .optional(),
    generatedFiles: z.array(GeneratedCodeFileSchema).optional(),
  })
  .strict()

const UpdateMessageMetadataBodySchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  metadata: AssistantMetadataPatchSchema,
})

const SaveGeneratedFileBodySchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  blockIndex: z.number().int().nonnegative(),
  language: z.string().min(1),
  content: z.string().min(1),
})

const conversationsRoutes = new Hono<HonoEnv>()
  .get('/api/conversations', requireAuth, async (c) => {
    const env = getServerEnv(c)
    const { DATABASE_URL = '' } = env
    const email = c.get('email')
    const fileServerPublicBaseUrl = resolveFileServerPublicBaseUrl(env)
    const conversations = await chatConversationRepository.read(DATABASE_URL, email, fileServerPublicBaseUrl)

    if (!conversations) {
      return c.json({ data: [] })
    }

    return c.json({ data: conversations })
  })
  .post('/api/conversations', requireAuth, sValidator('json', ConversationSchema), async (c) => {
    const { DATABASE_URL = '' } = getServerEnv(c)
    const email = c.get('email')
    const req = c.req.valid('json')
    await chatConversationRepository.upsert(DATABASE_URL, email, req)

    return c.json({ conversationId: req.id })
  })
  .delete('/api/conversations', requireAuth, sValidator('query', ConversationIdsQuerySchema), async (c) => {
    const { DATABASE_URL = '' } = getServerEnv(c)
    const email = c.get('email')
    const { ids } = c.req.valid('query')
    const result = await chatConversationRepository.delete(DATABASE_URL, email, ids)

    return c.json(result)
  })
  .delete('/api/conversations/messages', requireAuth, sValidator('query', ConversationIdsQuerySchema), async (c) => {
    const { DATABASE_URL = '' } = getServerEnv(c)
    const email = c.get('email')
    const { ids } = c.req.valid('query')
    const result = await chatConversationRepository.deleteMessages(DATABASE_URL, email, ids)

    return c.json(result)
  })
  .patch(
    '/api/conversations/messages/metadata',
    requireAuth,
    sValidator('json', UpdateMessageMetadataBodySchema),
    async (c) => {
      const { DATABASE_URL = '' } = getServerEnv(c)
      const email = c.get('email')
      const body = c.req.valid('json')
      const result = await chatConversationRepository.updateMessageMetadata(DATABASE_URL, email, {
        conversationId: body.conversationId,
        messageId: body.messageId,
        metadataPatch: body.metadata,
      })

      if (!result.ok) {
        if (result.reason === 'user-not-found' || result.reason === 'message-not-found') {
          return c.json({ error: 'Not found' }, 404)
        }
        if (result.reason === 'forbidden') {
          return c.json({ error: 'Forbidden' }, 403)
        }
        return c.json({ error: 'Only assistant messages can be updated' }, 400)
      }

      return c.json({ metadata: result.metadata })
    }
  )
  .post(
    '/api/conversations/messages/generated-files',
    requireAuth,
    sValidator('json', SaveGeneratedFileBodySchema),
    async (c) => {
      const env = getServerEnv(c)
      const { DATABASE_URL = '' } = env
      const email = c.get('email')
      const body = c.req.valid('json')
      const fileServerConfig = resolveFileServerConfig(env)

      const result = await chatConversationRepository.saveGeneratedFile(
        DATABASE_URL,
        email,
        {
          conversationId: body.conversationId,
          messageId: body.messageId,
          blockIndex: body.blockIndex,
          language: body.language,
          content: body.content,
        },
        fileServerConfig
      )

      if (!result.ok) {
        if (result.reason === 'user-not-found' || result.reason === 'message-not-found') {
          return c.json({ error: 'Not found' }, 404)
        }
        if (result.reason === 'forbidden') {
          return c.json({ error: 'Forbidden' }, 403)
        }
        if (result.reason === 'invalid-role') {
          return c.json({ error: 'Unsupported language or message role' }, 400)
        }
        if (result.reason === 'file-server-unavailable') {
          return c.json({ error: 'File server not configured' }, 503)
        }
        return c.json({ error: 'Failed to upload generated file' }, 502)
      }

      return c.json({ file: result.file, alreadyExisted: result.alreadyExisted })
    }
  )

export { conversationsRoutes }
