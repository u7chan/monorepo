import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { uuidv7 } from 'uuidv7'
import {
  createTemplate,
  getTemplateById,
  getTemplates,
  softDeleteTemplate,
  updateTemplate,
} from '#/server/features/templates/template-repository'
import type { HonoEnv } from '#/server/routes/shared'
import { CreateSubtitleTemplateSchema, UpdateSubtitleTemplateSchema } from '#/shared/schemas'

const templateRoutes = new Hono<HonoEnv>()

templateRoutes.get('/', (c) => {
  const db = c.var.db
  const templates = getTemplates(db)
  return c.json(templates)
})

templateRoutes.get('/:templateId', (c) => {
  const db = c.var.db
  const template = getTemplateById(db, c.req.param('templateId'))
  if (!template) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json(template)
})

templateRoutes.post('/', sValidator('json', CreateSubtitleTemplateSchema), (c) => {
  const db = c.var.db
  const body = c.req.valid('json')
  const template = createTemplate(db, {
    id: uuidv7(),
    ...body,
  })
  return c.json(template, 201)
})

templateRoutes.patch('/:templateId', sValidator('json', UpdateSubtitleTemplateSchema), (c) => {
  const db = c.var.db
  const id = c.req.param('templateId')
  const existing = getTemplateById(db, id)
  if (!existing) {
    return c.json({ error: 'not found' }, 404)
  }
  const updated = updateTemplate(db, id, c.req.valid('json'))
  return c.json(updated)
})

templateRoutes.delete('/:templateId', (c) => {
  const db = c.var.db
  const id = c.req.param('templateId')
  const existing = getTemplateById(db, id)
  if (!existing) {
    return c.json({ error: 'not found' }, 404)
  }
  softDeleteTemplate(db, id)
  return c.body(null, 204)
})

export { templateRoutes }
