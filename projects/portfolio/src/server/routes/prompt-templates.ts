import { Hono } from 'hono'
import { promptTemplateRepository } from '#/server/features/prompt-templates/repository'
import { logger } from '#/server/lib/logger'
import type { HonoEnv } from './shared'
import { getServerEnv } from './shared'

const promptTemplatesRoutes = new Hono<HonoEnv>().get('/api/prompt-templates', async (c) => {
  const { DATABASE_URL = '' } = getServerEnv(c)
  const requestLogger = c.var.logger ?? logger

  try {
    const templates = await promptTemplateRepository.read(DATABASE_URL)
    return c.json({ data: templates })
  } catch (error) {
    requestLogger.error({ err: error }, 'Failed to read prompt templates')
    return c.json({ data: [] }, 500)
  }
})

export { promptTemplatesRoutes }
