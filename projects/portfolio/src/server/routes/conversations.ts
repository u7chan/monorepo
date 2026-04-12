import { chatConversationRepository } from '#/server/features/chat-conversations/repository'
import { requireAuth } from '#/server/middleware/auth'
import { ConversationSchema } from '#/types'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const ConversationIdsQuerySchema = z.object({
  ids: z.union([z.string(), z.array(z.string())]).transform((value) => (Array.isArray(value) ? value : [value])),
})

const conversationsRoutes = new Hono<HonoEnv>()
  .get('/api/conversations', requireAuth, async (c) => {
    const { DATABASE_URL = '' } = getServerEnv(c)
    const email = c.get('email')
    const conversations = await chatConversationRepository.read(DATABASE_URL, email)

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

export { conversationsRoutes }
